import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MarketingOpsError } from './errors.js';

const CHANNEL_IDS = [
  'juejin',
  'v2ex',
  'bilibili',
  'zhihu',
  'xiaohongshu',
  'wechat',
  'hacker-news',
  'reddit',
  'product-hunt',
  'github',
  'weibo',
  'bluesky',
  'dev',
  'mastodon',
  'x',
] as const;

export const LEGACY_PROJECT_ID = 'algorithm-visualizer';
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface ReceiptFields {
  campaignId: string;
  channel: (typeof CHANNEL_IDS)[number];
  postId: string;
  publicUrl: string;
  publishedAt: string;
  contentHash: string;
  idempotencyKey: string;
  adapterVersion: string;
  status: 'queued' | 'published' | 'failed' | 'deleted';
}

export interface LegacyPublishReceipt extends ReceiptFields {
  schemaVersion: 1;
}

export interface ProjectPublishReceipt extends ReceiptFields {
  schemaVersion: 2;
  projectId: string;
}

export type PublishReceipt = LegacyPublishReceipt | ProjectPublishReceipt;

export interface PublicPostRef {
  channel: PublishReceipt['channel'];
  postId: string;
  publicUrl: string;
}

const BASE_RECEIPT_KEYS = [
  'schemaVersion',
  'campaignId',
  'channel',
  'postId',
  'publicUrl',
  'publishedAt',
  'contentHash',
  'idempotencyKey',
  'adapterVersion',
  'status',
] as const;
const PROJECT_RECEIPT_KEYS = [...BASE_RECEIPT_KEYS, 'projectId'] as const;
const MAX_RECEIPT_BYTES = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) {
    throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt schema is invalid');
  }
  return value;
}

function parseReceipt(value: unknown): PublishReceipt {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt schema is invalid');
  }
  const allowedKeys = value.schemaVersion === 1 ? BASE_RECEIPT_KEYS : PROJECT_RECEIPT_KEYS;
  if (Object.keys(value).some((key) => !allowedKeys.includes(key as never))) {
    throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt schema is invalid');
  }
  const channel = requireString(value, 'channel');
  const publicUrl = requireString(value, 'publicUrl');
  const publishedAt = requireString(value, 'publishedAt');
  const contentHash = requireString(value, 'contentHash');
  const status = requireString(value, 'status');
  if (
    !CHANNEL_IDS.includes(channel as PublishReceipt['channel']) ||
    !/^https:\/\//.test(publicUrl) ||
    Number.isNaN(Date.parse(publishedAt)) ||
    !/^[a-f0-9]{64}$/.test(contentHash) ||
    !['queued', 'published', 'failed', 'deleted'].includes(status)
  ) {
    throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt schema is invalid');
  }
  const fields: ReceiptFields = {
    campaignId: requireString(value, 'campaignId'),
    channel: channel as PublishReceipt['channel'],
    postId: requireString(value, 'postId'),
    publicUrl,
    publishedAt,
    contentHash,
    idempotencyKey: requireString(value, 'idempotencyKey'),
    adapterVersion: requireString(value, 'adapterVersion'),
    status: status as PublishReceipt['status'],
  };
  if (value.schemaVersion === 1) return { schemaVersion: 1, ...fields };
  const projectId = requireString(value, 'projectId');
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt schema is invalid');
  }
  return { schemaVersion: 2, projectId, ...fields };
}

export function receiptProjectId(receipt: PublishReceipt): string {
  return receipt.schemaVersion === 1 ? LEGACY_PROJECT_ID : receipt.projectId;
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export class ReceiptStore {
  readonly #directory: string;

  constructor(root: string) {
    this.#directory = resolve(root, 'receipts');
  }

  async save(receiptInput: PublishReceipt): Promise<{ receipt: PublishReceipt; reused: boolean }> {
    const receipt = parseReceipt(receiptInput);
    await this.#ensureDirectory();
    const path = this.#pathFor(receipt.idempotencyKey);
    const existing = await this.getByIdempotencyKey(receipt.idempotencyKey);
    if (existing) return { receipt: existing, reused: true };

    const temporary = join(this.#directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    let created = true;
    try {
      await link(temporary, path);
      await chmod(path, 0o600);
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') {
        throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt storage is corrupted');
      }
      created = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const metadata = await lstat(path);
        if (metadata.nlink === 1) break;
        await new Promise<void>((resolveSettled) => setImmediate(resolveSettled));
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const stored = await this.getByIdempotencyKey(receipt.idempotencyKey);
    if (!stored) throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt write was not durable');
    return { receipt: stored, reused: !created };
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<PublishReceipt | null> {
    await this.#ensureDirectory();
    try {
      return await this.#readStoredReceipt(this.#pathFor(idempotencyKey));
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof MarketingOpsError) throw error;
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt storage is corrupted');
    }
  }

  async listByCampaign(campaignId: string): Promise<PublishReceipt[]>;
  async listByCampaign(projectId: string, campaignId: string): Promise<PublishReceipt[]>;
  async listByCampaign(
    projectIdOrCampaignId: string,
    campaignIdInput?: string,
  ): Promise<PublishReceipt[]> {
    const projectId = campaignIdInput === undefined ? LEGACY_PROJECT_ID : projectIdOrCampaignId;
    const campaignId = campaignIdInput ?? projectIdOrCampaignId;
    return (await this.#allReceipts()).filter(
      (receipt) => receiptProjectId(receipt) === projectId && receipt.campaignId === campaignId,
    );
  }

  async findKnownPostRef(postRef: PublicPostRef): Promise<PublishReceipt | null>;
  async findKnownPostRef(projectId: string, postRef: PublicPostRef): Promise<PublishReceipt | null>;
  async findKnownPostRef(
    projectIdOrPostRef: string | PublicPostRef,
    postRefInput?: PublicPostRef,
  ): Promise<PublishReceipt | null> {
    const projectId =
      typeof projectIdOrPostRef === 'string' ? projectIdOrPostRef : LEGACY_PROJECT_ID;
    const postRef = typeof projectIdOrPostRef === 'string' ? postRefInput : projectIdOrPostRef;
    if (!postRef) throw new MarketingOpsError('INVALID_INPUT', 'Post reference is required');
    return this.#uniquePostRefMatch(
      (await this.#allReceipts()).filter((receipt) => receiptProjectId(receipt) === projectId),
      postRef,
    );
  }

  async findByPostRef(campaignId: string, postRef: PublicPostRef): Promise<PublishReceipt | null>;
  async findByPostRef(
    projectId: string,
    campaignId: string,
    postRef: PublicPostRef,
  ): Promise<PublishReceipt | null>;
  async findByPostRef(
    projectIdOrCampaignId: string,
    campaignIdOrPostRef: string | PublicPostRef,
    postRefInput?: PublicPostRef,
  ): Promise<PublishReceipt | null> {
    const legacy = typeof campaignIdOrPostRef !== 'string';
    const projectId = legacy ? LEGACY_PROJECT_ID : projectIdOrCampaignId;
    const campaignId = legacy ? projectIdOrCampaignId : campaignIdOrPostRef;
    const postRef = legacy ? campaignIdOrPostRef : postRefInput;
    if (!postRef) throw new MarketingOpsError('INVALID_INPUT', 'Post reference is required');
    return this.#uniquePostRefMatch(await this.listByCampaign(projectId, campaignId), postRef);
  }

  async markDeleted(idempotencyKey: string): Promise<PublishReceipt>;
  async markDeleted(projectId: string, idempotencyKey: string): Promise<PublishReceipt>;
  async markDeleted(
    projectIdOrIdempotencyKey: string,
    idempotencyKeyInput?: string,
  ): Promise<PublishReceipt> {
    const projectId =
      idempotencyKeyInput === undefined ? LEGACY_PROJECT_ID : projectIdOrIdempotencyKey;
    const idempotencyKey = idempotencyKeyInput ?? projectIdOrIdempotencyKey;
    const existing = await this.getByIdempotencyKey(idempotencyKey);
    if (!existing || receiptProjectId(existing) !== projectId) {
      throw new MarketingOpsError('INVALID_INPUT', 'Known receipt was not found');
    }
    if (existing.status === 'deleted') return existing;
    const receipt = parseReceipt({ ...existing, status: 'deleted' });
    const temporary = join(this.#directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await rename(temporary, this.#pathFor(idempotencyKey));
      await chmod(this.#pathFor(idempotencyKey), 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const stored = await this.getByIdempotencyKey(idempotencyKey);
    if (!stored || stored.status !== 'deleted') {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt update was not durable');
    }
    return stored;
  }

  async #allReceipts(): Promise<PublishReceipt[]> {
    await this.#ensureDirectory();
    let entries: Dirent[];
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt storage is corrupted');
    }
    const receiptEntries = entries.filter((entry) => entry.name.endsWith('.json'));
    if (receiptEntries.length > 10_000 || receiptEntries.some((entry) => !entry.isFile())) {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt storage is corrupted');
    }
    const receipts: PublishReceipt[] = [];
    for (const entry of receiptEntries) {
      try {
        receipts.push(await this.#readStoredReceipt(join(this.#directory, entry.name)));
      } catch (error) {
        if (error instanceof MarketingOpsError) throw error;
        throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt storage is corrupted');
      }
    }
    const references = new Set<string>();
    for (const receipt of receipts) {
      const reference = `${receipt.channel}\0${receipt.postId}\0${receipt.publicUrl}`;
      if (references.has(reference)) {
        throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt references are duplicated');
      }
      references.add(reference);
    }
    return receipts.sort(
      (left, right) =>
        left.publishedAt.localeCompare(right.publishedAt) ||
        left.channel.localeCompare(right.channel),
    );
  }

  #uniquePostRefMatch(receipts: PublishReceipt[], postRef: PublicPostRef): PublishReceipt | null {
    const matches = receipts.filter(
      (receipt) =>
        receipt.channel === postRef.channel &&
        receipt.postId === postRef.postId &&
        receipt.publicUrl === postRef.publicUrl,
    );
    return matches[0] ?? null;
  }

  async #ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await chmod(this.#directory, 0o700);
    } catch {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt storage is corrupted');
    }
  }

  async #readStoredReceipt(path: string): Promise<PublishReceipt> {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_RECEIPT_BYTES
    ) {
      throw new MarketingOpsError(
        'STORAGE_CORRUPTED',
        'Receipt file is not a private regular file',
      );
    }
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > MAX_RECEIPT_BYTES) {
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt file exceeds its safety limit');
    }
    return parseReceipt(JSON.parse(raw) as unknown);
  }

  #pathFor(idempotencyKey: string): string {
    const digest = createHash('sha256').update(idempotencyKey).digest('hex');
    return join(this.#directory, `${digest}.json`);
  }
}
