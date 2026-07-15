import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DevActivationStore } from './dev-activation-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'marketing-ops-dev-activation-'));
  roots.push(value);
  return value;
}

describe('DEV activation store', () => {
  it('TC-AUTO-DEVACT-127-01 缺失 activation 返回 null', async () => {
    await expect(new DevActivationStore(await root()).get()).resolves.toBeNull();
  });

  it('TC-AUTO-DEVACT-127-02 只以 0600 保存公开 username/userId', async () => {
    const directory = await root();
    const store = new DevActivationStore(directory, () => '2026-07-15T00:00:00.000Z');

    await expect(store.enable({ username: 'algorithmviz', userId: 12345 })).resolves.toEqual({
      schemaVersion: 1,
      channel: 'dev',
      username: 'algorithmviz',
      userId: 12345,
      enabled: true,
      enabledAt: '2026-07-15T00:00:00.000Z',
    });

    const path = join(directory, 'activations', 'dev.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toMatch(/api.?key|secret|token/i);
    await expect(store.get()).resolves.toMatchObject({ username: 'algorithmviz', userId: 12345 });
  });

  it('TC-AUTO-DEVACT-127-03 非法身份与损坏内容失败关闭', async () => {
    const directory = await root();
    const store = new DevActivationStore(directory);

    await expect(store.enable({ username: '../unsafe', userId: 1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(store.enable({ username: 'algorithmviz', userId: 0 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    await store.enable({ username: 'algorithmviz', userId: 12345 });
    const path = join(directory, 'activations', 'dev.json');
    await writeFile(path, '{broken', 'utf8');
    await expect(store.get()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });
  });

  it('TC-AUTO-DEVACT-127-04 宽权限文件和未来 schema 均拒绝', async () => {
    const directory = await root();
    const store = new DevActivationStore(directory);
    await store.enable({ username: 'algorithmviz', userId: 12345 });
    const path = join(directory, 'activations', 'dev.json');

    await chmod(path, 0o644);
    await expect(store.get()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });

    await chmod(path, 0o600);
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...value, schemaVersion: 2 })}\n`, 'utf8');
    await expect(store.get()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });
  });
});
