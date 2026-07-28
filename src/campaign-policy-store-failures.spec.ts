import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CampaignPolicy } from './campaign-policy-store.js';

const roots: string[] = [];
const POLICY: CampaignPolicy = {
  schemaVersion: 1,
  projectId: 'algorithm-visualizer',
  campaignId: 'quick-sort-launch',
  replies: { mode: 'faq-only', createBugIssues: true },
};

type FileSystemModule = typeof import('node:fs/promises');

afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), 'marketing-ops-policy-failure-'));
  roots.push(value);
  return value;
}

async function loadStore(overrides: (actual: FileSystemModule) => Partial<FileSystemModule>) {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<FileSystemModule>('node:fs/promises');
    return { ...actual, ...overrides(actual) };
  });
  return (await import('./campaign-policy-store.js')).CampaignPolicyStore;
}

describe('campaign policy filesystem failures', () => {
  it('TC-AUTO-POLICY-127-01 并发 EEXIST 复用且非竞争 link 错误全部失败关闭', async () => {
    const raceRoot = await root();
    const RacingStore = await loadStore((actual) => ({
      link: vi.fn(async (source, destination) => {
        await actual.link(source, destination);
        throw Object.assign(new Error('simulated race'), { code: 'EEXIST' });
      }),
    }));
    await expect(new RacingStore(raceRoot).save(POLICY)).resolves.toMatchObject({ reused: true });

    for (const error of [
      'primitive failure',
      null,
      new Error('no code'),
      Object.assign(new Error('private path'), { code: 'EPERM' }),
    ]) {
      const failureRoot = await root();
      const BrokenStore = await loadStore(() => ({
        link: vi.fn(async () => {
          throw error;
        }),
      }));
      await expect(new BrokenStore(failureRoot).save(POLICY)).rejects.toMatchObject({
        code: 'STORAGE_CORRUPTED',
        message: expect.not.stringContaining('private path'),
      });
    }
  });

  it('TC-AUTO-POLICY-127-01 cleanup、缺失落盘与异内容落盘均拒绝成功', async () => {
    const cleanupRoot = await root();
    const CleanupStore = await loadStore(() => ({
      unlink: vi.fn(async () => {
        throw Object.assign(new Error('cleanup failed'), { code: 'EPERM' });
      }),
    }));
    await expect(new CleanupStore(cleanupRoot).save(POLICY)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    const missingRoot = await root();
    const MissingStore = await loadStore((actual) => ({
      link: vi.fn(async () => undefined),
      chmod: vi.fn(async (path, mode) => {
        try {
          await actual.chmod(path, mode);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }),
    }));
    await expect(new MissingStore(missingRoot).save(POLICY)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
      message: 'Campaign policy write was not durable',
    });

    const mismatchRoot = await root();
    const MismatchStore = await loadStore((actual) => ({
      readFile: vi.fn(async (path, options) => {
        if (String(path).endsWith('.json')) {
          return JSON.stringify({
            ...POLICY,
            replies: { mode: 'off', createBugIssues: true },
          });
        }
        return actual.readFile(path, options as never);
      }) as unknown as FileSystemModule['readFile'],
    }));
    await expect(new MismatchStore(mismatchRoot).save(POLICY)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
      message: 'Campaign policy write was not durable',
    });
  });

  it('TC-AUTO-POLICY-127-01 lstat/read 与目录异常统一脱敏', async () => {
    for (const error of [
      'primitive failure',
      null,
      new Error('no code'),
      Object.assign(new Error('private path'), { code: 'EIO' }),
    ]) {
      const failureRoot = await root();
      const BrokenReadStore = await loadStore(() => ({
        lstat: vi.fn(async () => {
          throw error;
        }) as FileSystemModule['lstat'],
      }));
      await expect(
        new BrokenReadStore(failureRoot).get(POLICY.projectId, POLICY.campaignId),
      ).rejects.toMatchObject({
        code: 'STORAGE_CORRUPTED',
        message: expect.not.stringContaining('private path'),
      });
    }

    const invalidRoot = await root();
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
    const actualStore = await import('./campaign-policy-store.js');
    await new actualStore.CampaignPolicyStore(invalidRoot).save(POLICY);
    const InvalidJsonStore = await loadStore((actual) => ({
      readFile: vi.fn(async (path, options) => {
        if (String(path).endsWith('.json')) return '{';
        return actual.readFile(path, options as never);
      }) as unknown as FileSystemModule['readFile'],
    }));
    await expect(
      new InvalidJsonStore(invalidRoot).get(POLICY.projectId, POLICY.campaignId),
    ).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });

    const directoryRoot = await root();
    const BrokenDirectoryStore = await loadStore(() => ({
      mkdir: vi.fn(async () => {
        throw Object.assign(new Error('private path'), { code: 'EIO' });
      }) as FileSystemModule['mkdir'],
    }));
    await expect(
      new BrokenDirectoryStore(directoryRoot).get(POLICY.projectId, POLICY.campaignId),
    ).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
      message: expect.not.stringContaining('private path'),
    });
  });
});
