import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
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

  it('TC-AUTO-GHSTORE-127-01..02 可按 campaign/postRef 查询并原子标记 deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(root);
    const store = new ReceiptStore(root);
    const receipt = makeReceipt();
    await store.save(receipt);
    await store.save({
      ...receipt,
      campaignId: 'other-campaign',
      idempotencyKey: 'campaign-v1/other-campaign/abc12345',
      postId: 'release-2',
    });

    await expect(store.listByCampaign(receipt.campaignId)).resolves.toEqual([receipt]);
    await expect(
      store.findByPostRef(receipt.campaignId, {
        channel: receipt.channel,
        postId: receipt.postId,
        publicUrl: receipt.publicUrl,
      }),
    ).resolves.toEqual(receipt);
    await expect(
      store.findByPostRef('other-campaign', {
        channel: receipt.channel,
        postId: receipt.postId,
        publicUrl: receipt.publicUrl,
      }),
    ).resolves.toBeNull();

    const deleted = await store.markDeleted(receipt.idempotencyKey);
    expect(deleted).toEqual({ ...receipt, status: 'deleted' });
    const [stored] = await store.listByCampaign(receipt.campaignId);
    expect(stored).toEqual(deleted);
    const files = await readdir(join(root, 'receipts'));
    for (const file of files) {
      expect((await stat(join(root, 'receipts', file))).mode & 0o777).toBe(0o600);
    }
  });

  it('TC-AUTO-GHSTORE-127-02 非私有文件或符号链接失败关闭', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(root);
    const store = new ReceiptStore(root);
    const receipt = makeReceipt();
    await store.save(receipt);
    const [file] = await readdir(join(root, 'receipts'));
    const path = join(root, 'receipts', file!);

    await chmod(path, 0o644);
    await expect(store.getByIdempotencyKey(receipt.idempotencyKey)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    const outside = join(root, 'outside.json');
    await writeFile(outside, JSON.stringify(receipt), { mode: 0o600 });
    await unlink(path);
    await symlink(outside, path);
    await expect(store.listByCampaign(receipt.campaignId)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });
  });

  it('TC-AUTO-GHSTORE-127-01 并发同键只创建一次且准确报告复用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(root);
    const store = new ReceiptStore(root);
    const receipt = makeReceipt();

    const results = await Promise.all([store.save(receipt), store.save(receipt)]);
    expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
    expect(await readdir(join(root, 'receipts'))).toHaveLength(1);
  });

  it('TC-AUTO-GHSTORE-127-01 已知引用、缺失引用与重复删除均确定返回', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(root);
    const store = new ReceiptStore(root);
    const receipt = makeReceipt();
    const postRef = {
      channel: receipt.channel,
      postId: receipt.postId,
      publicUrl: receipt.publicUrl,
    };

    await expect(store.getByIdempotencyKey('missing-key')).resolves.toBeNull();
    await expect(store.findKnownPostRef(postRef)).resolves.toBeNull();
    await expect(store.markDeleted('missing-key')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await store.save(receipt);
    await expect(store.findKnownPostRef(postRef)).resolves.toEqual(receipt);
    const deleted = await store.markDeleted(receipt.idempotencyKey);
    await expect(store.markDeleted(receipt.idempotencyKey)).resolves.toEqual(deleted);
  });

  it('TC-AUTO-GHSTORE-127-02 schema、重复公开引用与目录项损坏均失败关闭', async () => {
    const schemaCases: unknown[] = [
      null,
      { ...makeReceipt(), schemaVersion: 2 },
      { ...makeReceipt(), schemaVersion: 2, projectId: '../escape' },
      { ...makeReceipt(), campaignId: '' },
      { ...makeReceipt(), channel: 'unknown' },
      { ...makeReceipt(), publicUrl: 'http://example.com' },
      { ...makeReceipt(), publishedAt: 'not-a-date' },
      { ...makeReceipt(), contentHash: 'short' },
      { ...makeReceipt(), status: 'unknown' },
      { ...makeReceipt(), unexpected: true },
    ];
    for (const value of schemaCases) {
      const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
      roots.push(root);
      const store = new ReceiptStore(root);
      const receipt = makeReceipt();
      await store.save(receipt);
      const [file] = await readdir(join(root, 'receipts'));
      await writeFile(join(root, 'receipts', file!), JSON.stringify(value), { mode: 0o600 });
      await expect(store.getByIdempotencyKey(receipt.idempotencyKey)).rejects.toMatchObject({
        code: 'STORAGE_CORRUPTED',
      });
    }

    for (const raw of [JSON.stringify({ ...makeReceipt(), schemaVersion: 2 }), '{broken']) {
      const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
      roots.push(root);
      const store = new ReceiptStore(root);
      const receipt = makeReceipt();
      await store.save(receipt);
      const [file] = await readdir(join(root, 'receipts'));
      await writeFile(join(root, 'receipts', file!), raw, { mode: 0o600 });
      await expect(store.listByCampaign(receipt.campaignId)).rejects.toMatchObject({
        code: 'STORAGE_CORRUPTED',
      });
    }

    const duplicateRoot = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(duplicateRoot);
    const duplicateStore = new ReceiptStore(duplicateRoot);
    const receipt = makeReceipt();
    await duplicateStore.save(receipt);
    await duplicateStore.save({
      ...receipt,
      idempotencyKey: 'campaign-v1/quick-sort-launch/different-key',
      postId: 'release-2',
      publicUrl: 'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/v2',
    });
    const files = await readdir(join(duplicateRoot, 'receipts'));
    const original = await readFile(join(duplicateRoot, 'receipts', files[0]!), 'utf8');
    await writeFile(join(duplicateRoot, 'receipts', files[1]!), original, { mode: 0o600 });
    await expect(duplicateStore.listByCampaign(receipt.campaignId)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    const entryRoot = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(entryRoot);
    const entryStore = new ReceiptStore(entryRoot);
    await entryStore.listByCampaign('empty');
    await mkdir(join(entryRoot, 'receipts', 'directory.json'));
    await expect(entryStore.listByCampaign('empty')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });
  });

  it('TC-AUTO-ISOLATION-133-02 项目 overload 缺参和精确引用均失败关闭', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(root);
    const store = new ReceiptStore(root);
    const legacy = makeReceipt();
    await store.save(legacy);
    const postRef = {
      channel: legacy.channel,
      postId: legacy.postId,
      publicUrl: legacy.publicUrl,
    };

    await expect(
      store.findByPostRef('algorithm-visualizer', legacy.campaignId, postRef),
    ).resolves.toEqual(legacy);
    await expect(
      (store.findKnownPostRef as unknown as (projectId: string) => Promise<unknown>)(
        'algorithm-visualizer',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      (
        store.findByPostRef as unknown as (
          projectId: string,
          campaignId: string,
        ) => Promise<unknown>
      )('algorithm-visualizer', legacy.campaignId),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('TC-AUTO-GHSTORE-127-02 硬链接、超限文件和不可建目录均失败关闭', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(root);
    const store = new ReceiptStore(root);
    const receipt = makeReceipt();
    await store.save(receipt);
    const [file] = await readdir(join(root, 'receipts'));
    const path = join(root, 'receipts', file!);
    await link(path, join(root, 'receipt-copy.json'));
    await expect(store.getByIdempotencyKey(receipt.idempotencyKey)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });
    await unlink(join(root, 'receipt-copy.json'));
    await writeFile(path, 'x'.repeat(65_537), { mode: 0o600 });
    await expect(store.getByIdempotencyKey(receipt.idempotencyKey)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    const blockedRoot = await mkdtemp(join(tmpdir(), 'marketing-ops-receipt-'));
    roots.push(blockedRoot);
    await writeFile(join(blockedRoot, 'receipts'), 'not-a-directory');
    await expect(new ReceiptStore(blockedRoot).listByCampaign('campaign')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });
  });
});
