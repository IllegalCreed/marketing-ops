import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileManager } from './profile-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('marketing-ops browser Profiles', () => {
  it('TC-AUTO-PROFILE-127-01 Profile 按渠道隔离、0700 且公开状态不含路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-profile-'));
    roots.push(root);
    const manager = new ProfileManager(root);
    const path = await manager.ensure('bluesky');
    const mode = (await stat(path)).mode & 0o777;
    const status = await manager.getPublicHealth('bluesky', async () => 'ready');

    expect(path.startsWith(root)).toBe(true);
    expect(mode).toBe(0o700);
    expect(status).toEqual({ channel: 'bluesky', health: 'ready', errorCode: null });
    expect(JSON.stringify(status)).not.toContain(path);
  });

  it('TC-AUTO-PROFILE-127-02 challenge、设备确认和未知页面全部失败关闭', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-profile-'));
    roots.push(root);
    const manager = new ProfileManager(root);

    await expect(manager.getPublicHealth('bluesky', async () => 'challenge')).resolves.toEqual({
      channel: 'bluesky',
      health: 'blocked',
      errorCode: 'CHALLENGE_REQUIRED',
    });
    await expect(
      manager.getPublicHealth('bluesky', async () => 'device-confirmation'),
    ).resolves.toEqual({
      channel: 'bluesky',
      health: 'blocked',
      errorCode: 'REAUTH_REQUIRED',
    });
    await expect(manager.getPublicHealth('bluesky', async () => 'unknown-page')).resolves.toEqual({
      channel: 'bluesky',
      health: 'blocked',
      errorCode: 'UNKNOWN_PAGE',
    });
    expect(Object.getOwnPropertyNames(ProfileManager.prototype)).not.toEqual(
      expect.arrayContaining(['bypassChallenge', 'enableStealth', 'solveCaptcha']),
    );
  });
});
