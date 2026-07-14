import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BlueskyActivationStore } from './bluesky-activation-store.js';

const HANDLE = 'algorithms-visualization.bsky.social';
const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), 'marketing-ops-bluesky-activation-'));
  roots.push(value);
  return value;
}

describe('Bluesky activation store', () => {
  it('TC-AUTO-BSKYACT-127-01 缺失 activation 返回 null', async () => {
    await expect(new BlueskyActivationStore(await root()).get()).resolves.toBeNull();
  });

  it('TC-AUTO-BSKYACT-127-02 只写 0600 非秘密账号绑定', async () => {
    const directory = await root();
    const store = new BlueskyActivationStore(directory, () => '2026-07-14T10:00:00.000Z');

    await expect(store.enable({ handle: HANDLE, did: DID })).resolves.toEqual({
      schemaVersion: 1,
      channel: 'bluesky',
      handle: HANDLE,
      did: DID,
      enabled: true,
      enabledAt: '2026-07-14T10:00:00.000Z',
    });
    const path = join(directory, 'activations', 'bluesky.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toMatch(/app.?password|cookie|jwt|secret|token/i);
    await expect(store.get()).resolves.toMatchObject({ handle: HANDLE, did: DID });
  });

  it('TC-AUTO-BSKYACT-127-03 默认时钟有效且身份参数严格', async () => {
    const store = new BlueskyActivationStore(await root());
    const activation = await store.enable({ handle: HANDLE, did: DID });

    expect(Number.isNaN(Date.parse(activation.enabledAt))).toBe(false);
    await expect(store.enable({ handle: 'invalid', did: DID })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(store.enable({ handle: HANDLE, did: 'invalid' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('TC-AUTO-BSKYACT-127-04 损坏、错渠道与未来版本失败关闭', async () => {
    for (const value of [
      '{broken',
      JSON.stringify({
        schemaVersion: 1,
        channel: 'github',
        handle: HANDLE,
        did: DID,
        enabled: true,
        enabledAt: '2026-07-14T10:00:00.000Z',
      }),
      JSON.stringify({
        schemaVersion: 2,
        channel: 'bluesky',
        handle: HANDLE,
        did: DID,
        enabled: true,
        enabledAt: '2026-07-14T10:00:00.000Z',
      }),
    ]) {
      const directory = await root();
      const activationDirectory = join(directory, 'activations');
      await mkdir(activationDirectory, { recursive: true, mode: 0o700 });
      const path = join(activationDirectory, 'bluesky.json');
      await writeFile(path, value, { mode: 0o600 });
      await chmod(path, 0o600);
      const store = new BlueskyActivationStore(directory);

      await expect(store.get()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });
      await expect(store.enable({ handle: HANDLE, did: DID })).rejects.toMatchObject({
        code: 'STORAGE_CORRUPTED',
      });
    }
  });
});
