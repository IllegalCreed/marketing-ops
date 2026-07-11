import { describe, expect, it, vi } from 'vitest';
import { WeiboChannelController } from './weibo-channel.js';
import type { WeiboCliHealth } from './adapters/weibo-cli.js';

function controller(health: WeiboCliHealth) {
  return new WeiboChannelController({
    client: { checkHealth: vi.fn(async () => health) },
  });
}

describe('Weibo channel fail-closed runtime status', () => {
  it('TC-AUTO-WBRUNTIME-127-01 health ready 也不在 publish action/activation 冻结前启用 adapter', async () => {
    const status = await controller({
      alias: '可视化算法',
      health: 'ready',
      reason: 'READY',
      gates: { login: true, developerVerification: true, freePlan: true },
    }).getStatus();

    expect(status).toEqual({
      channel: 'weibo',
      alias: '可视化算法',
      health: 'ready',
      adapterReady: false,
      nextAction: 'Run marketing-ops setup weibo to freeze the Free publish command',
    });
  });

  it('TC-AUTO-WBRUNTIME-127-01 每个失败 gate 只给脱敏下一步', async () => {
    await expect(
      controller({
        alias: null,
        health: 'not-configured',
        reason: 'CLI_NOT_FOUND',
        gates: { login: false, developerVerification: false, freePlan: false },
      }).getStatus(),
    ).resolves.toMatchObject({
      health: 'not-configured',
      nextAction: 'Install official @weibo-ai/weibo-cli',
    });
    await expect(
      controller({
        alias: null,
        health: 'reauth-required',
        reason: 'LOGIN_REQUIRED',
        gates: { login: false, developerVerification: false, freePlan: false },
      }).getStatus(),
    ).resolves.toMatchObject({ nextAction: 'Run marketing-ops setup weibo' });
    await expect(
      controller({
        alias: '可视化算法',
        health: 'blocked',
        reason: 'DEVELOPER_VERIFICATION_REQUIRED',
        gates: { login: true, developerVerification: false, freePlan: false },
      }).getStatus(),
    ).resolves.toMatchObject({ nextAction: 'Complete Weibo personal developer verification' });
    await expect(
      controller({
        alias: '可视化算法',
        health: 'blocked',
        reason: 'FREE_PLAN_REQUIRED',
        gates: { login: true, developerVerification: true, freePlan: false },
      }).getStatus(),
    ).resolves.toMatchObject({ nextAction: 'Activate the Weibo Free plan or trial' });
    await expect(
      controller({
        alias: '可视化算法',
        health: 'blocked',
        reason: 'ZERO_COST_PLAN_REQUIRED',
        gates: { login: true, developerVerification: true, freePlan: false },
      }).getStatus(),
    ).resolves.toMatchObject({ nextAction: 'Use the Weibo Free plan; paid plans are disabled' });
    await expect(
      controller({
        alias: null,
        health: 'blocked',
        reason: 'TEMPORARY_FAILURE',
        gates: { login: false, developerVerification: false, freePlan: false },
      }).getStatus(),
    ).resolves.toMatchObject({ nextAction: 'Run marketing-ops doctor' });
  });
});
