import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MastodonActivationStore } from './mastodon-activation-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'marketing-ops-mastodon-activation-'));
  roots.push(value);
  return value;
}

describe('Mastodon activation store', () => {
  it('TC-AUTO-MASTOACT-127-01 缺失 activation 返回 null', async () => {
    await expect(new MastodonActivationStore(await root()).get()).resolves.toBeNull();
  });

  it('TC-AUTO-MASTOACT-127-02 只以 0600 保存公开实例与账号绑定', async () => {
    const directory = await root();
    const store = new MastodonActivationStore(directory, () => '2026-07-16T00:00:00.000Z');

    await expect(
      store.enable({
        instanceUrl: 'https://mastodon.social',
        alias: 'illegalcreed@mastodon.social',
        accountId: '109876',
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      channel: 'mastodon',
      instanceUrl: 'https://mastodon.social',
      alias: 'illegalcreed@mastodon.social',
      accountId: '109876',
      enabled: true,
      enabledAt: '2026-07-16T00:00:00.000Z',
    });

    const path = join(directory, 'activations', 'mastodon.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toMatch(/token|secret|cookie|password/i);
    await expect(store.get()).resolves.toMatchObject({
      instanceUrl: 'https://mastodon.social',
      alias: 'illegalcreed@mastodon.social',
      accountId: '109876',
    });
  });

  it('TC-AUTO-MASTOACT-127-03 非法身份与损坏内容失败关闭', async () => {
    const directory = await root();
    const store = new MastodonActivationStore(directory);

    await expect(
      store.enable({
        instanceUrl: 'http://mastodon.social',
        alias: 'illegalcreed@mastodon.social',
        accountId: '109876',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      store.enable({
        instanceUrl: 'https://mastodon.social',
        alias: 'not an acct',
        accountId: '109876',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await store.enable({
      instanceUrl: 'https://mastodon.social',
      alias: 'illegalcreed@mastodon.social',
      accountId: '109876',
    });
    await writeFile(join(directory, 'activations', 'mastodon.json'), '{broken', 'utf8');
    await expect(store.get()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });
  });

  it('TC-AUTO-MASTOACT-127-04 宽权限文件和未来 schema 均拒绝', async () => {
    const directory = await root();
    const store = new MastodonActivationStore(directory);
    await store.enable({
      instanceUrl: 'https://mastodon.social',
      alias: 'illegalcreed@mastodon.social',
      accountId: '109876',
    });
    const path = join(directory, 'activations', 'mastodon.json');

    await chmod(path, 0o644);
    await expect(store.get()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });

    await chmod(path, 0o600);
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...value, schemaVersion: 2 })}\n`, 'utf8');
    await expect(store.get()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });
  });
});
