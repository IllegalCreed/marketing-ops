import { chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AUTOMATIC_CHANNELS, type AutomaticChannel } from './onboarding.js';
import { MarketingOpsError, type MarketingOpsErrorCode } from './errors.js';

export type ProfileProbeResult =
  'ready' | 'login-required' | 'challenge' | 'device-confirmation' | 'unknown-page';

export interface PublicProfileHealth {
  channel: AutomaticChannel;
  health: 'ready' | 'blocked';
  errorCode: Extract<
    MarketingOpsErrorCode,
    'CHALLENGE_REQUIRED' | 'REAUTH_REQUIRED' | 'UNKNOWN_PAGE'
  > | null;
}

export class ProfileManager {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async ensure(channel: AutomaticChannel): Promise<string> {
    if (!AUTOMATIC_CHANNELS.includes(channel)) {
      throw new MarketingOpsError('INVALID_INPUT', 'Unsupported Profile channel');
    }
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const path = resolve(this.#root, channel);
    if (!path.startsWith(`${this.#root}/`)) {
      throw new MarketingOpsError('INVALID_INPUT', 'Profile path escaped its private root');
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    return path;
  }

  async getPublicHealth(
    channel: AutomaticChannel,
    probe: (path: string) => Promise<ProfileProbeResult>,
  ): Promise<PublicProfileHealth> {
    const path = await this.ensure(channel);
    const result = await probe(path);
    if (result === 'ready') return { channel, health: 'ready', errorCode: null };
    if (result === 'challenge') {
      return { channel, health: 'blocked', errorCode: 'CHALLENGE_REQUIRED' };
    }
    if (result === 'unknown-page') {
      return { channel, health: 'blocked', errorCode: 'UNKNOWN_PAGE' };
    }
    return { channel, health: 'blocked', errorCode: 'REAUTH_REQUIRED' };
  }
}
