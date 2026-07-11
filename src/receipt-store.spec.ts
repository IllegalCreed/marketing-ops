import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReceiptStore, type PublishReceipt } from './receipt-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeReceipt(): PublishReceipt {
  return {
    schemaVersion: 1,
    campaignId: 'quick-sort-launch',
    channel: 'github',
    postId: 'release-1',
    publicUrl: 'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/v1',
    publishedAt: '2026-07-11T12:00:00.000Z',
    contentHash: 'a'.repeat(64),
    idempotencyKey: 'campaign-v1/quick-sort-launch/abc12345',
    adapterVersion: 'github@0.1.0',
    status: 'published',
  };
}

describe('marketing-ops receipt store', () => {
  it('TC-AUTO-RECEIPT-127-01 receipt 仅含公开字段且相同幂等键复用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(root);
    const store = new ReceiptStore(root);
    const receipt = makeReceipt();

    await expect(store.save(receipt)).resolves.toEqual({ receipt, reused: false });
    await expect(store.save({ ...receipt, postId: 'different' })).resolves.toEqual({
      receipt,
      reused: true,
    });
    const files = await readdir(join(root, 'receipts'));
    expect(files).toHaveLength(1);
    const raw = await readFile(join(root, 'receipts', files[0]!), 'utf8');
    expect(raw).not.toMatch(/cookie|password|profile|secret|storageState|token/i);
  });

  it('TC-AUTO-RECEIPT-127-02 原子 0600 持久化且损坏内容失败关闭', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(root);
    const store = new ReceiptStore(root);
    const receipt = makeReceipt();
    await store.save(receipt);

    const [file] = await readdir(join(root, 'receipts'));
    const path = join(root, 'receipts', file!);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o600);
    await writeFile(path, '{broken', { mode: 0o600 });

    await expect(store.getByIdempotencyKey(receipt.idempotencyKey)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });
  });
});
