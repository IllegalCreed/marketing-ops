import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProjectProfileStore,
  parseProjectProfile,
  type ProjectProfile,
} from './project-profile-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'marketing-ops-project-'));
  roots.push(root);
  return root;
}

function profile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    schemaVersion: 1,
    id: 'algorithm-visualizer',
    displayName: 'Algorithm Visualizer',
    canonicalOrigins: ['https://algo.illegalscreed.cn', 'https://illegalcreed.github.io'],
    channels: ['github', 'bluesky', 'dev', 'mastodon'],
    github: { repository: 'IllegalCreed/algorithms-visualization' },
    dev: { tags: ['algorithms', 'webdev', 'opensource'] },
    ...overrides,
  };
}

describe('project profile store', () => {
  it('TC-AUTO-PROJECT-133-01 规范化后原子保存、读取和列出 0600 profile', async () => {
    const root = await temporaryRoot();
    const store = new ProjectProfileStore(root);
    const expected = profile({
      canonicalOrigins: [
        'https://illegalcreed.github.io/',
        'https://algo.illegalscreed.cn/',
        'https://algo.illegalscreed.cn',
      ],
      channels: ['mastodon', 'github', 'dev', 'bluesky'],
    });

    await expect(store.save(expected)).resolves.toEqual({
      ...expected,
      canonicalOrigins: ['https://algo.illegalscreed.cn', 'https://illegalcreed.github.io'],
      channels: ['github', 'bluesky', 'dev', 'mastodon'],
      dev: { tags: ['algorithms', 'opensource', 'webdev'] },
    });
    await expect(store.get('algorithm-visualizer')).resolves.toEqual(
      expect.objectContaining({ id: 'algorithm-visualizer' }),
    );
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id: 'algorithm-visualizer' }),
    ]);

    const path = join(root, 'projects', 'algorithm-visualizer.json');
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, 'projects'))).mode & 0o777).toBe(0o700);
    expect(await readFile(path, 'utf8')).not.toMatch(
      /access.?token|api.?key|app.?password|cookie|password|secret|storage.?state/i,
    );
  });

  it('TC-AUTO-PROJECT-133-02 严格拒绝非法字段、目标与凭据', () => {
    for (const value of [
      profile({ id: '../escape' }),
      profile({ displayName: '' }),
      profile({ canonicalOrigins: ['http://example.com'] }),
      profile({ canonicalOrigins: ['not-a-url'] }),
      profile({ canonicalOrigins: ['https://example.com/path'] }),
      profile({ canonicalOrigins: ['https://user@example.com'] }),
      profile({ github: { repository: 'owner/repo;rm' } }),
      profile({ channels: ['github', 'github'] }),
      { ...profile(), channels: ['dev'], github: undefined, dev: undefined },
      { ...profile(), channels: ['github'], github: undefined, dev: undefined },
      profile({ dev: { tags: ['Bad Tag'] } }),
      profile({ dev: { tags: ['same', 'same'] } }),
      profile({ dev: { tags: ['one', 'two', 'three', 'four', 'five'] } }),
      { ...profile(), accessToken: 'not-allowed' },
    ]) {
      expect(() => parseProjectProfile(value)).toThrow();
    }
  });

  it('TC-AUTO-PROJECT-133-03 宽松权限、symlink、损坏文件与目录替换失败关闭', async () => {
    const root = await temporaryRoot();
    const store = new ProjectProfileStore(root);
    await store.save(profile());
    const path = join(root, 'projects', 'algorithm-visualizer.json');

    await chmod(path, 0o644);
    await expect(store.get('algorithm-visualizer')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    await chmod(path, 0o600);
    await writeFile(path, '{broken', { mode: 0o600 });
    await expect(store.list()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });

    const symlinkRoot = await temporaryRoot();
    const outside = join(symlinkRoot, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(symlinkRoot, 'projects'));
    await expect(new ProjectProfileStore(symlinkRoot).list()).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });

    const exactDirectoryRoot = await temporaryRoot();
    await mkdir(join(exactDirectoryRoot, 'projects'), { mode: 0o600 });
    await expect(new ProjectProfileStore(exactDirectoryRoot).list()).rejects.toMatchObject({
      code: 'STORAGE_CORRUPTED',
    });
  });

  it('TC-AUTO-PROJECT-133-01..03 缺失、排序、无可选策略与文件身份均确定处理', async () => {
    const root = await temporaryRoot();
    const store = new ProjectProfileStore(root);
    await expect(store.get('missing-project')).resolves.toBeNull();
    await expect(store.require('missing-project')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    const minimal: ProjectProfile = {
      schemaVersion: 1,
      id: 'beta-project',
      displayName: 'Beta',
      canonicalOrigins: ['https://beta.example'],
      channels: ['bluesky'],
    };
    await store.save(minimal);
    await store.save(profile());
    await expect(store.list()).resolves.toMatchObject([
      { id: 'algorithm-visualizer' },
      { id: 'beta-project', channels: ['bluesky'] },
    ]);
    await expect(store.save(profile({ displayName: 'Updated name' }))).resolves.toMatchObject({
      displayName: 'Updated name',
    });

    const projectsDirectory = join(root, 'projects');
    await writeFile(
      join(projectsDirectory, 'wrong-name.json'),
      `${JSON.stringify({ ...minimal, id: 'different-name' })}\n`,
      { mode: 0o600 },
    );
    await expect(store.list()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });

    await rm(join(projectsDirectory, 'wrong-name.json'));
    await mkdir(join(projectsDirectory, 'unexpected.json'), { mode: 0o700 });
    await expect(store.list()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });
  });
});
