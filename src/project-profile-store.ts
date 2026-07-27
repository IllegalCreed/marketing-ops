import { randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { CHANNEL_IDS, PROJECT_ID_PATTERN, type ChannelId } from './contract.js';
import { MarketingOpsError } from './errors.js';

const MAX_PROFILE_BYTES = 65_536;
const MAX_PROFILES = 1_000;
const projectIdSchema = z.string().regex(new RegExp(PROJECT_ID_PATTERN));
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const tagSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,29}$/);
const profileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: projectIdSchema,
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    canonicalOrigins: z.array(z.string().min(1).max(2_048)).min(1).max(10),
    channels: z.array(z.enum(CHANNEL_IDS)).min(1).max(CHANNEL_IDS.length),
    github: z.object({ repository: repositorySchema }).strict().optional(),
    dev: z
      .object({ tags: z.array(tagSchema).min(1).max(4) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.channels).size !== value.channels.length) {
      context.addIssue({ code: 'custom', path: ['channels'], message: 'Channels must be unique' });
    }
    if (value.channels.includes('github') !== Boolean(value.github)) {
      context.addIssue({
        code: 'custom',
        path: ['github'],
        message: 'GitHub configuration must match the channel selection',
      });
    }
    if (value.channels.includes('dev') !== Boolean(value.dev)) {
      context.addIssue({
        code: 'custom',
        path: ['dev'],
        message: 'DEV configuration must match the channel selection',
      });
    }
    if (value.dev && new Set(value.dev.tags).size !== value.dev.tags.length) {
      context.addIssue({
        code: 'custom',
        path: ['dev', 'tags'],
        message: 'DEV tags must be unique',
      });
    }
  });

export interface ProjectProfile {
  schemaVersion: 1;
  id: string;
  displayName: string;
  canonicalOrigins: string[];
  channels: ChannelId[];
  github?: { repository: string };
  dev?: { tags: string[] };
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MarketingOpsError('INVALID_INPUT', 'Project origin must be a valid HTTPS origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new MarketingOpsError('INVALID_INPUT', 'Project origin must be a valid HTTPS origin');
  }
  return url.origin;
}

export function parseProjectProfile(value: unknown): ProjectProfile {
  const result = profileSchema.safeParse(value);
  if (!result.success) {
    throw new MarketingOpsError('INVALID_INPUT', 'Project profile is invalid');
  }
  const parsed = result.data;
  const canonicalOrigins = [...new Set(parsed.canonicalOrigins.map(normalizeOrigin))].sort();
  const channels = [...parsed.channels].sort(
    (left, right) => CHANNEL_IDS.indexOf(left) - CHANNEL_IDS.indexOf(right),
  );
  return {
    schemaVersion: 1,
    id: parsed.id,
    displayName: parsed.displayName,
    canonicalOrigins,
    channels,
    ...(parsed.github ? { github: { repository: parsed.github.repository } } : {}),
    ...(parsed.dev ? { dev: { tags: [...parsed.dev.tags].sort() } } : {}),
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function assertPrivateDirectory(metadata: Stats): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile directory is not private');
  }
}

function assertPrivateFile(metadata: Stats): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size > MAX_PROFILE_BYTES
  ) {
    throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile is not a private file');
  }
}

export class ProjectProfileStore {
  readonly #directory: string;

  constructor(root: string) {
    this.#directory = resolve(root, 'projects');
  }

  async save(value: unknown): Promise<ProjectProfile> {
    const profile = parseProjectProfile(value);
    await this.#ensureDirectory();
    const path = this.#path(profile.id);
    try {
      assertPrivateFile(await lstat(path));
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof MarketingOpsError) throw error;
        throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile storage is corrupted');
      }
    }

    const temporary = join(this.#directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const stored = await this.get(profile.id);
    if (!stored) {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile write was not durable');
    }
    return stored;
  }

  async get(projectId: string): Promise<ProjectProfile | null> {
    const id = projectIdSchema.parse(projectId);
    await this.#ensureDirectory();
    try {
      return await this.#read(this.#path(id), id);
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof MarketingOpsError) throw error;
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile storage is corrupted');
    }
  }

  async require(projectId: string): Promise<ProjectProfile> {
    const profile = await this.get(projectId);
    if (!profile) {
      throw new MarketingOpsError('INVALID_INPUT', 'Known project profile was not found');
    }
    return profile;
  }

  async list(): Promise<ProjectProfile[]> {
    await this.#ensureDirectory();
    let entries: Dirent[];
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile storage is corrupted');
    }
    const profileEntries = entries.filter((entry) => entry.name.endsWith('.json'));
    if (
      profileEntries.length > MAX_PROFILES ||
      profileEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    ) {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile storage is corrupted');
    }
    const profiles: ProjectProfile[] = [];
    for (const entry of profileEntries) {
      const id = entry.name.slice(0, -'.json'.length);
      try {
        profiles.push(await this.#read(join(this.#directory, entry.name), id));
      } catch (error) {
        if (error instanceof MarketingOpsError) throw error;
        throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile storage is corrupted');
      }
    }
    return profiles.sort((left, right) => left.id.localeCompare(right.id));
  }

  async #ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      assertPrivateDirectory(await lstat(this.#directory));
    } catch (error) {
      if (error instanceof MarketingOpsError) throw error;
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile storage is corrupted');
    }
  }

  async #read(path: string, expectedId: string): Promise<ProjectProfile> {
    const metadata = await lstat(path);
    assertPrivateFile(metadata);
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > MAX_PROFILE_BYTES) {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile exceeds its safety limit');
    }
    let profile: ProjectProfile;
    try {
      profile = parseProjectProfile(JSON.parse(raw) as unknown);
    } catch {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile schema is invalid');
    }
    if (profile.id !== expectedId) {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Project profile identity is invalid');
    }
    return profile;
  }

  #path(projectId: string): string {
    return join(this.#directory, `${projectId}.json`);
  }
}
