import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
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

export interface PublishReceipt {
  schemaVersion: 1;
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

const RECEIPT_KEYS = [
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
  if (!isRecord(value) || Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key as never))) {
    throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt schema is invalid');
  }
  if (value.schemaVersion !== 1) {
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
  return {
    schemaVersion: 1,
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
    try {
      await link(temporary, path);
      await chmod(path, 0o600);
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const stored = await this.getByIdempotencyKey(receipt.idempotencyKey);
    if (!stored) throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt write was not durable');
    return { receipt: stored, reused: stored.postId !== receipt.postId };
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<PublishReceipt | null> {
    await this.#ensureDirectory();
    try {
      const raw = await readFile(this.#pathFor(idempotencyKey), 'utf8');
      return parseReceipt(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof MarketingOpsError) throw error;
      throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt storage is corrupted');
    }
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
  }

  #pathFor(idempotencyKey: string): string {
    const digest = createHash('sha256').update(idempotencyKey).digest('hex');
    return join(this.#directory, `${digest}.json`);
  }
}
