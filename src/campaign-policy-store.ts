import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { MarketingOpsError } from './errors.js';

const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    campaignId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    replies: z
      .object({
        mode: z.enum(['off', 'faq-only']),
        createBugIssues: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type CampaignPolicy = z.infer<typeof policySchema>;

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class CampaignPolicyStore {
  readonly #directory: string;

  constructor(root: string) {
    this.#directory = resolve(root, 'campaign-policies');
  }

  async save(value: CampaignPolicy): Promise<{ policy: CampaignPolicy; reused: boolean }> {
    const policy = policySchema.parse(value);
    await this.#ensureDirectory();
    const path = this.#pathFor(policy.projectId, policy.campaignId);
    const existing = await this.get(policy.projectId, policy.campaignId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(policy)) {
        throw new MarketingOpsError(
          'STORAGE_CORRUPTED',
          'Campaign policy conflicts with the stored policy',
        );
      }
      return { policy: existing, reused: true };
    }
    const temporary = join(this.#directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    let created = true;
    try {
      await link(temporary, path);
      await chmod(path, 0o600);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) {
        throw new MarketingOpsError('STORAGE_CORRUPTED', 'Campaign policy storage is corrupted');
      }
      created = false;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const stored = await this.get(policy.projectId, policy.campaignId);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(policy)) {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Campaign policy write was not durable');
    }
    return { policy: stored, reused: !created };
  }

  async get(projectId: string, campaignId: string): Promise<CampaignPolicy | null> {
    await this.#ensureDirectory();
    const path = this.#pathFor(projectId, campaignId);
    try {
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size > 8_192
      ) {
        throw new MarketingOpsError(
          'STORAGE_CORRUPTED',
          'Campaign policy file is not a private regular file',
        );
      }
      const raw = await readFile(path, 'utf8');
      return policySchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if (missing(error)) return null;
      if (error instanceof MarketingOpsError) throw error;
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Campaign policy storage is corrupted');
    }
  }

  async #ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await chmod(this.#directory, 0o700);
    } catch {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Campaign policy storage is corrupted');
    }
  }

  #pathFor(projectId: string, campaignId: string): string {
    const digest = createHash('sha256').update(`${projectId}\0${campaignId}`).digest('hex');
    return join(this.#directory, `${digest}.json`);
  }
}
