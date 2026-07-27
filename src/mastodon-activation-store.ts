import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { MarketingOpsError } from './errors.js';

const MAX_ACTIVATION_BYTES = 16_384;
const instanceUrlPattern = /^https:\/\/[a-z0-9.-]+(?::\d{2,5})?$/i;
const aliasPattern =
  /^(?=.{3,255}$)[a-z0-9_][a-z0-9_.-]{0,127}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const activationSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.literal('mastodon'),
    instanceUrl: z.string().regex(instanceUrlPattern),
    alias: z.string().regex(aliasPattern),
    accountId: z.string().regex(/^[1-9]\d{0,63}$/),
    enabled: z.literal(true),
    enabledAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type MastodonActivation = z.infer<typeof activationSchema>;

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class MastodonActivationStore {
  readonly #directory: string;
  readonly #now: () => string;

  constructor(root: string, now: () => string = () => new Date().toISOString()) {
    this.#directory = resolve(root, 'activations');
    this.#now = now;
  }

  async get(): Promise<MastodonActivation | null> {
    await this.#ensureDirectory();
    try {
      const metadata = await lstat(this.#path());
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size > MAX_ACTIVATION_BYTES
      ) {
        throw new Error('Unsafe activation file');
      }
      const raw = await readFile(this.#path(), 'utf8');
      return activationSchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isMissing(error)) return null;
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Activation storage is corrupted');
    }
  }

  async enable(identity: {
    instanceUrl: string;
    alias: string;
    accountId: string;
  }): Promise<MastodonActivation> {
    await this.get();
    const parsedIdentity = activationSchema
      .omit({ schemaVersion: true, channel: true, enabled: true, enabledAt: true })
      .safeParse(identity);
    if (!parsedIdentity.success) {
      throw new MarketingOpsError('INVALID_INPUT', 'Mastodon activation identity is invalid');
    }
    const activation = activationSchema.parse({
      schemaVersion: 1,
      channel: 'mastodon',
      ...parsedIdentity.data,
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
    return join(this.#directory, 'mastodon.json');
  }
}
