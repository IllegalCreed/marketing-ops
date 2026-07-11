import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublishReceipt } from './receipt-store.js';

const roots: string[] = [];

afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function receipt(): PublishReceipt {
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

type FileSystemModule = typeof import('node:fs/promises');

async function loadReceiptStore(
  overrides: (actual: FileSystemModule) => Partial<FileSystemModule>,
) {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<FileSystemModule>('node:fs/promises');
    return { ...actual, ...overrides(actual) };
  });
  return (await import('./receipt-store.js')).ReceiptStore;
}

async function savedRoot() {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  const { ReceiptStore } = await import('./receipt-store.js');
  const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-failure-'));
  roots.push(root);
  const value = receipt();
  await new ReceiptStore(root).save(value);
  return { root, value };
}

describe('receipt store filesystem failures', () => {
  it('TC-AUTO-GHSTORE-127-02 非竞争 link 失败被脱敏', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-failure-'));
    roots.push(root);
    const ReceiptStore = await loadReceiptStore(() => ({
      link: vi.fn(async () => {
        throw Object.assign(new Error('/private/path failed'), { code: 'EPERM' });
      }),
    }));

    const result = new ReceiptStore(root).save(receipt());
    await expect(result).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
      message: expect.not.stringContaining('/private/path'),
    });
  });

  it('TC-AUTO-GHSTORE-127-02 原子创建未落盘和 cleanup 失败均失败关闭', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-failure-'));
    roots.push(root);
    const ReceiptStore = await loadReceiptStore((actual) => ({
      link: vi.fn(async () => undefined),
      chmod: vi.fn(async (path, mode) => {
        try {
          await actual.chmod(path, mode);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }),
      unlink: vi.fn(async () => {
        throw Object.assign(new Error('cleanup failed'), { code: 'EPERM' });
      }),
    }));

    await expect(new ReceiptStore(root).save(receipt())).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
      message: 'Receipt write was not durable',
    });
  });

  it('TC-AUTO-GHSTORE-127-02 deleted 更新未落盘时拒绝成功', async () => {
    const { root, value } = await savedRoot();
    const ReceiptStore = await loadReceiptStore(() => ({
      rename: vi.fn(async () => undefined),
    }));

    await expect(new ReceiptStore(root).markDeleted(value.idempotencyKey)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
      message: 'Receipt update was not durable',
    });
  });

  it('TC-AUTO-GHSTORE-127-02 readdir 与读取期增长失败关闭', async () => {
    const { root, value } = await savedRoot();
    const BrokenReadStore = await loadReceiptStore(() => ({
      readdir: vi.fn(async () => {
        throw Object.assign(new Error('/private/path failed'), { code: 'EIO' });
      }),
    }));
    await expect(new BrokenReadStore(root).listByCampaign(value.campaignId)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    vi.doUnmock('node:fs/promises');
    vi.resetModules();
    const [file] = await readdir(join(root, 'receipts'));
    const path = join(root, 'receipts', file!);
    const original = await readFile(path, 'utf8');
    await writeFile(path, original, { mode: 0o600 });
    await chmod(path, 0o600);
    const GrowingReadStore = await loadReceiptStore((actual) => ({
      readFile: vi.fn(async (target, options) => {
        if (target === path && options === 'utf8') return 'x'.repeat(65_537);
        return actual.readFile(target, options as never);
      }) as FileSystemModule['readFile'],
    }));
    await expect(
      new GrowingReadStore(root).getByIdempotencyKey(value.idempotencyKey),
    ).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
      message: 'Receipt file exceeds its safety limit',
    });
  });
});
