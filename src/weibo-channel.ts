import type { WeiboCliHealth } from './adapters/weibo-cli.js';

export interface PublicWeiboChannelStatus {
  channel: 'weibo';
  alias: string | null;
  health: 'ready' | 'not-configured' | 'reauth-required' | 'blocked';
  adapterReady: false;
  nextAction: string;
}

interface WeiboHealthClient {
  checkHealth(): Promise<WeiboCliHealth>;
}

function nextAction(health: WeiboCliHealth): string {
  if (health.reason === 'CLI_NOT_FOUND') return 'Install official @weibo-ai/weibo-cli';
  if (health.reason === 'LOGIN_REQUIRED') return 'Run marketing-ops setup weibo';
  if (health.reason === 'DEVELOPER_VERIFICATION_REQUIRED') {
    return 'Complete Weibo personal developer verification';
  }
  if (health.reason === 'FREE_PLAN_REQUIRED') return 'Activate the Weibo Free plan or trial';
  if (health.reason === 'ZERO_COST_PLAN_REQUIRED') {
    return 'Use the Weibo Free plan; paid plans are disabled';
  }
  if (health.reason === 'READY') {
    return 'Weibo Free is read-only; keep publishing disabled';
  }
  return 'Run marketing-ops doctor';
}

export class WeiboChannelController {
  readonly #client: WeiboHealthClient;

  constructor(options: { client: WeiboHealthClient }) {
    this.#client = options.client;
  }

  async getStatus(): Promise<PublicWeiboChannelStatus> {
    const health = await this.#client.checkHealth();
    return {
      channel: 'weibo',
      alias: health.alias,
      health: health.health,
      adapterReady: false,
      nextAction: nextAction(health),
    };
  }
}
