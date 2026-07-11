import { describe, expect, it } from 'vitest';
import {
  assertSecureSetupInvocation,
  CHANNEL_SETUP_CATALOG,
  createPublicChannelStatus,
  planChannelSetup,
} from './onboarding.js';

describe('marketing-ops onboarding', () => {
  it('TC-AUTO-SETUP-127-01 首批渠道只使用批准的授权方式', () => {
    expect(CHANNEL_SETUP_CATALOG.map(({ id, method }) => [id, method])).toEqual([
      ['github', 'github-cli'],
      ['weibo', 'device-oauth'],
      ['bluesky', 'app-password'],
      ['dev', 'api-key'],
      ['mastodon', 'oauth'],
    ]);
    expect(CHANNEL_SETUP_CATALOG.every((channel) => !channel.acceptsPrimaryPassword)).toBe(true);
  });

  it('TC-AUTO-SETUP-127-02 secret 只经隐藏 TTY 或官方授权进入 Keychain', () => {
    expect(planChannelSetup('dev')).toMatchObject({
      secretInput: 'hidden-tty',
      persist: 'keychain',
      requiresJson: false,
    });
    expect(planChannelSetup('mastodon')).toMatchObject({
      secretInput: 'official-browser',
      persist: 'keychain',
      requiresJson: false,
    });
    expect(() =>
      assertSecureSetupInvocation(['setup', 'dev', '--token', 'unsafe'], {}, true),
    ).toThrow(/secret.*argument/i);
    expect(() =>
      assertSecureSetupInvocation(['setup', 'dev'], { DEV_API_KEY: 'unsafe' }, true),
    ).toThrow(/secret.*environment/i);
    expect(() => assertSecureSetupInvocation(['setup', 'dev'], {}, false)).toThrow(/tty/i);
  });

  it('TC-AUTO-SETUP-127-03 status/doctor 只返回别名、健康与下一步', () => {
    const output = createPublicChannelStatus({
      id: 'bluesky',
      alias: '@demo.bsky.social',
      health: 'reauth-required',
      nextAction: 'Run marketing-ops setup bluesky',
      secretRef: 'channel/bluesky/app-password',
      profilePath: '/private/profile/path',
    });

    expect(output).toEqual({
      channel: 'bluesky',
      alias: '@demo.bsky.social',
      health: 'reauth-required',
      nextAction: 'Run marketing-ops setup bluesky',
    });
    expect(JSON.stringify(output)).not.toMatch(/secretRef|profilePath|private\/profile/);
  });
});
