import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { MarketingOpsError } from './errors.js';

const activationSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.literal('github'),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    enabled: z.literal(true),
    enabledAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type GitHubActivation = z.infer<typeof activationSchema>;

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class GitHubActivationStore {
  readonly #directory: string;
  readonly #repository: string;
  readonly #now: () => string;

  constructor(
    root: string,
    repository: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new MarketingOpsError('INVALID_INPUT', 'GitHub repository must be owner/name');
    }
    this.#directory = resolve(root, 'activations');
    this.#repository = repository;
    this.#now = now;
  }

  async get(): Promise<GitHubActivation | null> {
    await this.#ensureDirectory();
    try {
      const raw = await readFile(this.#path(), 'utf8');
      const activation = activationSchema.parse(JSON.parse(raw) as unknown);
      if (activation.repository.toLowerCase() !== this.#repository.toLowerCase()) {
        throw new MarketingOpsError('STORAGE_CORRUPTED', 'Activation repository is invalid');
      }
      return activation;
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof MarketingOpsError) throw error;
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Activation storage is corrupted');
    }
  }

  async enable(): Promise<GitHubActivation> {
    await this.get();
    const activation = activationSchema.parse({
      schemaVersion: 1,
      channel: 'github',
      repository: this.#repository,
      enabled: true,
      enabledAt: this.#now(),
    });
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
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
  }

  #path(): string {
    return join(this.#directory, 'github.json');
  }
}
