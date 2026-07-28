import { chmod, lstat, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CampaignPolicyStore } from './campaign-policy-store.js';

const POLICY = {
  schemaVersion: 1 as const,
  projectId: 'algorithm-visualizer',
  campaignId: 'quick-sort-launch',
  replies: { mode: 'faq-only' as const, createBugIssues: true },
};

describe('campaign reply policy store', () => {
  it('TC-AUTO-POLICY-127-01 0700/0600 原子保存、同策略复用与跨项目隔离', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-policy-'));
    const store = new CampaignPolicyStore(root);

    await expect(store.save(POLICY)).resolves.toEqual({ policy: POLICY, reused: false });
    await expect(store.save(POLICY)).resolves.toEqual({ policy: POLICY, reused: true });
    await expect(store.get(POLICY.projectId, POLICY.campaignId)).resolves.toEqual(POLICY);
    await expect(store.get('different-project', POLICY.campaignId)).resolves.toBeNull();

    const directory = join(root, 'campaign-policies');
    expect((await lstat(directory)).mode & 0o077).toBe(0);
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
    expect(entries).toHaveLength(1);
    expect((await lstat(join(directory, entries[0]!))).mode & 0o077).toBe(0);
    expect(await readFile(join(directory, entries[0]!), 'utf8')).not.toContain('authorization');
  });

  it('TC-AUTO-POLICY-127-01 异策略、损坏和宽权限文件失败关闭', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-policy-'));
    const store = new CampaignPolicyStore(root);
    await store.save(POLICY);

    await expect(
      store.save({ ...POLICY, replies: { mode: 'off', createBugIssues: true } }),
    ).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });

    const directory = join(root, 'campaign-policies');
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
    const path = join(directory, entries[0]!);
    await chmod(path, 0o644);
    await expect(store.get(POLICY.projectId, POLICY.campaignId)).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });
  });
});
