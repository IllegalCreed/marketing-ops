import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectProfile } from './project-profile-store.js';

const roots: string[] = [];

afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function profile(): ProjectProfile {
  return {
    schemaVersion: 1,
    id: 'algorithm-visualizer',
    displayName: 'Algorithm Visualizer',
    canonicalOrigins: ['https://algo.illegalscreed.cn'],
    channels: ['github'],
    github: { repository: 'IllegalCreed/algorithms-visualization' },
  };
}

type FileSystemModule = typeof import('node:fs/promises');

async function loadStore(overrides: (actual: FileSystemModule) => Partial<FileSystemModule>) {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<FileSystemModule>('node:fs/promises');
    return { ...actual, ...overrides(actual) };
  });
  return (await import('./project-profile-store.js')).ProjectProfileStore;
}

async function savedRoot() {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  const { ProjectProfileStore } = await import('./project-profile-store.js');
  const root = await mkdtemp(join(tmpdir(), 'marketing-ops-project-failure-'));
  roots.push(root);
  await new ProjectProfileStore(root).save(profile());
  return root;
}

describe('project profile filesystem failures', () => {
  it('TC-AUTO-PROJECT-133-03 既有 profile 的权限与 lstat 异常失败关闭', async () => {
    const root = await savedRoot();
    const path = join(root, 'projects', 'algorithm-visualizer.json');
    await chmod(path, 0o644);
    const { ProjectProfileStore } = await import('./project-profile-store.js');
    await expect(new ProjectProfileStore(root).save(profile())).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    await chmod(path, 0o600);
    const BrokenStore = await loadStore((actual) => ({
      lstat: vi.fn(async (target) => {
        if (target === path) throw Object.assign(new Error('private path'), { code: 'EIO' });
        return actual.lstat(target);
      }) as unknown as FileSystemModule['lstat'],
    }));
    await expect(new BrokenStore(root).save(profile())).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
      message: expect.not.stringContaining('private path'),
    });
  });

  it('TC-AUTO-PROJECT-133-03 原子替换未落盘时拒绝成功', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-project-failure-'));
    roots.push(root);
    const Store = await loadStore((actual) => ({
      rename: vi.fn(async () => undefined),
      chmod: vi.fn(async (target, mode) => {
        try {
          await actual.chmod(target, mode);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }),
    }));

    await expect(new Store(root).save(profile())).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
      message: 'Project profile write was not durable',
    });
  });

  it('TC-AUTO-PROJECT-133-03 读取、列举和建目录异常统一脱敏', async () => {
    const root = await savedRoot();
    const path = join(root, 'projects', 'algorithm-visualizer.json');
    const BrokenReadStore = await loadStore((actual) => ({
      readFile: vi.fn(async (target, options) => {
        if (target === path) throw Object.assign(new Error('private path'), { code: 'EIO' });
        return actual.readFile(target, options as never);
      }) as unknown as FileSystemModule['readFile'],
    }));
    await expect(new BrokenReadStore(root).get('algorithm-visualizer')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    const BrokenListStore = await loadStore(() => ({
      readdir: vi.fn(async () => {
        throw Object.assign(new Error('private path'), { code: 'EIO' });
      }) as FileSystemModule['readdir'],
    }));
    await expect(new BrokenListStore(root).list()).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    const BrokenEntryStore = await loadStore((actual) => ({
      lstat: vi.fn(async (target) => {
        if (String(target).endsWith('.json')) {
          throw Object.assign(new Error('private path'), { code: 'EIO' });
        }
        return actual.lstat(target);
      }) as unknown as FileSystemModule['lstat'],
    }));
    await expect(new BrokenEntryStore(root).list()).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    const blockedRoot = await mkdtemp(join(tmpdir(), 'marketing-ops-project-failure-'));
    roots.push(blockedRoot);
    const BrokenDirectoryStore = await loadStore(() => ({
      mkdir: vi.fn(async () => {
        throw Object.assign(new Error('private path'), { code: 'EIO' });
      }) as FileSystemModule['mkdir'],
    }));
    await expect(new BrokenDirectoryStore(blockedRoot).list()).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });
  });

  it('TC-AUTO-PROJECT-133-03 读取期增长超过上限时失败关闭', async () => {
    const root = await savedRoot();
    const [file] = await readdir(join(root, 'projects'));
    const path = join(root, 'projects', file!);
    expect(await readFile(path, 'utf8')).toContain('algorithm-visualizer');
    const GrowingStore = await loadStore((actual) => ({
      readFile: vi.fn(async (target, options) => {
        if (target === path && options === 'utf8') return 'x'.repeat(65_537);
        return actual.readFile(target, options as never);
      }) as FileSystemModule['readFile'],
    }));

    await expect(new GrowingStore(root).get('algorithm-visualizer')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
      message: 'Project profile exceeds its safety limit',
    });
  });
});
