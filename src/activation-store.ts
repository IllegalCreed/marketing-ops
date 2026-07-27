import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { MarketingOpsError } from './errors.js';

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const legacyActivationSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.literal('github'),
    repository: repositorySchema,
    enabled: z.literal(true),
    enabledAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const activationSchema = z
  .object({
    schemaVersion: z.literal(2),
    channel: z.literal('github'),
    projectId: projectIdSchema,
    repository: repositorySchema,
    enabled: z.literal(true),
    enabledAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type GitHubActivation = z.infer<typeof activationSchema>;

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class GitHubActivationStore {
  readonly #activationRoot: string;
  readonly #directory: string;
  readonly #projectId: string;
  readonly #repository: string;
  readonly #now: () => string;

  constructor(
    root: string,
    projectId: string,
    repository: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    if (!projectIdSchema.safeParse(projectId).success) {
      throw new MarketingOpsError('INVALID_INPUT', 'GitHub project ID is invalid');
    }
    if (!repositorySchema.safeParse(repository).success) {
      throw new MarketingOpsError(
        'INVALID_INPUT',
        'GitHub repository must use the owner/name format',
      );
    }
    this.#projectId = projectId;
    this.#repository = repository;
    this.#activationRoot = resolve(root, 'activations');
    this.#directory = join(this.#activationRoot, 'github');
    this.#now = now;
  }

  async get(): Promise<GitHubActivation | null> {
    await this.#ensureDirectory();
    try {
      return await this.#readCurrent();
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof MarketingOpsError) throw error;
        throw new MarketingOpsError('STORAGE_CORRUPTED', 'Activation storage is corrupted');
      }
    }
    return this.#migrateLegacy();
  }

  async enable(): Promise<GitHubActivation> {
    await this.get();
    return this.#write(
      activationSchema.parse({
        schemaVersion: 2,
        channel: 'github',
        projectId: this.#projectId,
        repository: this.#repository,
        enabled: true,
        enabledAt: this.#now(),
      }),
    );
  }

  async #migrateLegacy(): Promise<GitHubActivation | null> {
    try {
      const metadata = await lstat(this.#legacyPath());
      this.#assertPrivateFile(metadata);
      const legacy = legacyActivationSchema.parse(
        JSON.parse(await readFile(this.#legacyPath(), 'utf8')) as unknown,
      );
      if (legacy.repository.toLowerCase() !== this.#repository.toLowerCase()) return null;
      return this.#write({
        schemaVersion: 2,
        channel: 'github',
        projectId: this.#projectId,
        repository: this.#repository,
        enabled: true,
        enabledAt: legacy.enabledAt,
      });
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof MarketingOpsError) throw error;
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Activation storage is corrupted');
    }
  }

  async #readCurrent(): Promise<GitHubActivation> {
    const metadata = await lstat(this.#path());
    this.#assertPrivateFile(metadata);
    const activation = activationSchema.parse(
      JSON.parse(await readFile(this.#path(), 'utf8')) as unknown,
    );
    if (
      activation.projectId !== this.#projectId ||
      activation.repository.toLowerCase() !== this.#repository.toLowerCase()
    ) {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Activation project is invalid');
    }
    return activation;
  }

  async #write(activation: GitHubActivation): Promise<GitHubActivation> {
    const temporary = join(this.#directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(activation, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await rename(temporary, this.#path());
      await chmod(this.#path(), 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return activation;
  }

  async #ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.#activationRoot, { recursive: true, mode: 0o700 });
      await chmod(this.#activationRoot, 0o700);
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await chmod(this.#directory, 0o700);
    } catch {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Activation storage is corrupted');
    }
  }

  #assertPrivateFile(metadata: Stats): void {
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > 65_536
    ) {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Activation file is not private');
    }
  }

  #path(): string {
    return join(this.#directory, `${this.#projectId}.json`);
  }

  #legacyPath(): string {
    return join(this.#activationRoot, 'github.json');
  }
}
