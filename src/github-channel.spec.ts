import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubActivationStore } from './activation-store.js';
import { GitHubChannelController } from './github-channel.js';

const REPOSITORY = 'IllegalCreed/algorithms-visualization';
const PROJECT_ID = 'algorithm-visualizer';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), 'marketing-ops-activation-'));
  roots.push(value);
  return value;
}

function client(health: 'ready' | 'not-configured' | 'reauth-required' | 'blocked' = 'ready') {
  return {
    checkHealth: vi.fn(async () => ({
      alias: health === 'ready' || health === 'blocked' ? 'IllegalCreed' : null,
      health,
      reason:
        health === 'ready'
          ? ('READY' as const)
          : health === 'not-configured'
            ? ('CLI_NOT_FOUND' as const)
            : health === 'reauth-required'
              ? ('REAUTH_REQUIRED' as const)
              : ('WRITE_PERMISSION_REQUIRED' as const),
    })),
    findReleaseByTag: vi.fn(),
    createRelease: vi.fn(),
    deleteRelease: vi.fn(),
    findTagReference: vi.fn(),
    deleteTagReference: vi.fn(),
    getRelease: vi.fn(),
    listReleaseReactions: vi.fn(),
    getTrafficViews: vi.fn(),
    getTrafficClones: vi.fn(),
    getTrafficReferrers: vi.fn(),
    getTrafficPaths: vi.fn(),
    listIssueComments: vi.fn(),
  };
}

describe('GitHub activation and channel controller', () => {
  it('TC-AUTO-ACTIVATION-127-01 健康 ready 也不会自动启用', async () => {
    const directory = await root();
    const gh = client();
    const controller = new GitHubChannelController({
      client: gh,
      activations: new GitHubActivationStore(directory, PROJECT_ID, REPOSITORY),
      repository: REPOSITORY,
    });

    await expect(controller.getStatus()).resolves.toEqual({
      channel: 'github',
      alias: 'IllegalCreed',
      health: 'ready',
      adapterReady: false,
      nextAction: 'Run marketing-ops setup github',
    });
    await expect(controller.createRegistration()).resolves.toBeNull();
    expect(gh.checkHealth).toHaveBeenCalledOnce();
  });

  it('TC-AUTO-ACTIVATION-127-02 setup 仅在 ready 时写入 0600 非秘密状态', async () => {
    const directory = await root();
    const store = new GitHubActivationStore(
      directory,
      PROJECT_ID,
      REPOSITORY,
      () => '2026-07-11T10:00:00.000Z',
    );
    const gh = client();
    const controller = new GitHubChannelController({
      client: gh,
      activations: store,
      repository: REPOSITORY,
    });

    await expect(controller.enable()).resolves.toMatchObject({
      health: 'ready',
      adapterReady: true,
      nextAction: null,
    });
    const path = join(directory, 'activations', 'github', `${PROJECT_ID}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      schemaVersion: 2,
      channel: 'github',
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      enabled: true,
      enabledAt: '2026-07-11T10:00:00.000Z',
    });
    expect(raw).not.toMatch(/cookie|password|scope|secret|token/i);
    await expect(controller.createRegistration()).resolves.toMatchObject({
      enabled: true,
      health: 'ready',
      adapter: { definition: { channel: 'github' } },
    });
    await expect(controller.createEnabledClient()).resolves.toBe(gh);

    const unhealthyAfterEnable = new GitHubChannelController({
      client: client('blocked'),
      activations: store,
      repository: REPOSITORY,
    });
    await expect(unhealthyAfterEnable.getStatus()).resolves.toMatchObject({
      health: 'blocked',
      adapterReady: false,
    });
    await expect(unhealthyAfterEnable.createRegistration()).resolves.toBeNull();
    await expect(unhealthyAfterEnable.createEnabledClient()).resolves.toBeNull();

    const blocked = new GitHubChannelController({
      client: client('reauth-required'),
      activations: new GitHubActivationStore(await root(), PROJECT_ID, REPOSITORY),
      repository: REPOSITORY,
    });
    await expect(blocked.enable()).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });

    const unavailable = new GitHubChannelController({
      client: client('blocked'),
      activations: new GitHubActivationStore(await root(), PROJECT_ID, REPOSITORY),
      repository: REPOSITORY,
    });
    await expect(unavailable.enable()).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });

  it('TC-AUTO-ACTIVATION-127-02 默认时钟有效且仓库参数严格', async () => {
    const directory = await root();
    const activation = await new GitHubActivationStore(directory, PROJECT_ID, REPOSITORY).enable();

    expect(Number.isNaN(Date.parse(activation.enabledAt))).toBe(false);
    expect(() => new GitHubActivationStore(directory, PROJECT_ID, 'IllegalCreed/repo;rm')).toThrow(
      /owner\/name/i,
    );
    expect(() => new GitHubActivationStore(directory, '../escape', REPOSITORY)).toThrow();
  });

  it('TC-AUTO-MIGRATION-133-01 旧 GitHub activation 仅仓库匹配时迁移到项目目录', async () => {
    const directory = await root();
    const activationDirectory = join(directory, 'activations');
    await mkdir(activationDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(activationDirectory, 'github.json'),
      JSON.stringify({
        schemaVersion: 1,
        channel: 'github',
        repository: REPOSITORY,
        enabled: true,
        enabledAt: '2026-07-11T10:00:00.000Z',
      }),
      { mode: 0o600 },
    );

    const store = new GitHubActivationStore(directory, PROJECT_ID, REPOSITORY);
    await expect(store.get()).resolves.toMatchObject({
      schemaVersion: 2,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
    });
    expect(
      (await stat(join(activationDirectory, 'github', `${PROJECT_ID}.json`))).mode & 0o777,
    ).toBe(0o600);
    await expect(
      new GitHubActivationStore(directory, 'another-project', 'IllegalCreed/another').get(),
    ).resolves.toBeNull();

    const malformedRoot = await root();
    await mkdir(join(malformedRoot, 'activations'), { recursive: true, mode: 0o700 });
    await writeFile(join(malformedRoot, 'activations', 'github.json'), '{broken', {
      mode: 0o600,
    });
    await expect(
      new GitHubActivationStore(malformedRoot, PROJECT_ID, REPOSITORY).get(),
    ).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });

    const exposedRoot = await root();
    await mkdir(join(exposedRoot, 'activations'), { recursive: true, mode: 0o700 });
    const exposedPath = join(exposedRoot, 'activations', 'github.json');
    await writeFile(
      exposedPath,
      JSON.stringify({
        schemaVersion: 1,
        channel: 'github',
        repository: REPOSITORY,
        enabled: true,
        enabledAt: '2026-07-11T10:00:00.000Z',
      }),
      { mode: 0o600 },
    );
    await chmod(exposedPath, 0o644);
    await expect(
      new GitHubActivationStore(exposedRoot, PROJECT_ID, REPOSITORY).get(),
    ).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });
  });

  it('TC-AUTO-ACTIVATION-127-03 损坏、错仓库与未来版本失败关闭', async () => {
    for (const value of [
      '{broken',
      JSON.stringify({
        schemaVersion: 2,
        channel: 'github',
        projectId: PROJECT_ID,
        repository: 'someone/else',
        enabled: true,
        enabledAt: '2026-07-11T10:00:00.000Z',
      }),
      JSON.stringify({
        schemaVersion: 3,
        channel: 'github',
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        enabled: true,
        enabledAt: '2026-07-11T10:00:00.000Z',
      }),
    ]) {
      const directory = await root();
      const activationDirectory = join(directory, 'activations', 'github');
      await mkdir(activationDirectory, { recursive: true, mode: 0o700 });
      const path = join(activationDirectory, `${PROJECT_ID}.json`);
      await writeFile(path, value, { mode: 0o600 });
      await chmod(path, 0o600);
      const controller = new GitHubChannelController({
        client: client(),
        activations: new GitHubActivationStore(directory, PROJECT_ID, REPOSITORY),
        repository: REPOSITORY,
      });

      await expect(controller.getStatus()).resolves.toMatchObject({
        health: 'blocked',
        adapterReady: false,
      });
      await expect(controller.createRegistration()).resolves.toBeNull();
      await expect(controller.enable()).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });
    }

    const exposedDirectory = await root();
    const exposedActivationDirectory = join(exposedDirectory, 'activations', 'github');
    await mkdir(exposedActivationDirectory, { recursive: true, mode: 0o700 });
    const exposedPath = join(exposedActivationDirectory, `${PROJECT_ID}.json`);
    await writeFile(
      exposedPath,
      JSON.stringify({
        schemaVersion: 2,
        channel: 'github',
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        enabled: true,
        enabledAt: '2026-07-11T10:00:00.000Z',
      }),
      { mode: 0o600 },
    );
    await chmod(exposedPath, 0o644);
    await expect(
      new GitHubActivationStore(exposedDirectory, PROJECT_ID, REPOSITORY).get(),
    ).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });

    const blockedDirectory = await root();
    await writeFile(join(blockedDirectory, 'activations'), 'not a directory', { mode: 0o600 });
    await expect(
      new GitHubActivationStore(blockedDirectory, PROJECT_ID, REPOSITORY).get(),
    ).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });
  });

  it('TC-AUTO-GHAUTH-127-05 公开状态不包含内部授权细节', async () => {
    const controller = new GitHubChannelController({
      client: client('reauth-required'),
      activations: new GitHubActivationStore(await root(), PROJECT_ID, REPOSITORY),
      repository: REPOSITORY,
    });
    const status = await controller.getStatus();

    expect(status).toEqual({
      channel: 'github',
      alias: null,
      health: 'reauth-required',
      adapterReady: false,
      nextAction: 'Run marketing-ops setup github',
    });
    expect(JSON.stringify(status)).not.toMatch(/keyring|path|scope|secret|token/i);
  });
});
