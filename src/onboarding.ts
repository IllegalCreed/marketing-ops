import { MarketingOpsError } from './errors.js';

export const AUTOMATIC_CHANNELS = ['github', 'weibo', 'bluesky', 'dev', 'mastodon'] as const;
export type AutomaticChannel = (typeof AUTOMATIC_CHANNELS)[number];

export const CHANNEL_SETUP_CATALOG = [
  {
    id: 'github',
    label: 'GitHub',
    method: 'github-cli',
    secretInput: 'none',
    persist: 'existing-cli',
    acceptsPrimaryPassword: false,
  },
  {
    id: 'weibo',
    label: '微博',
    method: 'device-oauth',
    secretInput: 'official-browser',
    persist: 'keychain',
    acceptsPrimaryPassword: false,
  },
  {
    id: 'bluesky',
    label: 'Bluesky',
    method: 'app-password',
    secretInput: 'hidden-tty',
    persist: 'keychain',
    acceptsPrimaryPassword: false,
  },
  {
    id: 'dev',
    label: 'DEV Community',
    method: 'api-key',
    secretInput: 'hidden-tty',
    persist: 'keychain',
    acceptsPrimaryPassword: false,
  },
  {
    id: 'mastodon',
    label: 'Mastodon',
    method: 'oauth-token',
    secretInput: 'hidden-tty',
    persist: 'keychain',
    acceptsPrimaryPassword: false,
  },
] as const;

const SECRET_ARGUMENT_PATTERN =
  /--?(api.?key|app.?password|cookie|credential|password|profile|secret|storage.?state|token)/i;
const SECRET_ENV_PATTERN =
  /(api.?key|app.?password|cookie|credential|password|secret|storage.?state|token)/i;

export function planChannelSetup(channel: AutomaticChannel) {
  const definition = CHANNEL_SETUP_CATALOG.find((item) => item.id === channel);
  if (!definition) throw new MarketingOpsError('INVALID_INPUT', `Unsupported channel: ${channel}`);
  return { ...definition, requiresJson: false };
}

export function assertSecureSetupInvocation(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  stdinIsTty: boolean,
): void {
  if (argv.some((argument) => SECRET_ARGUMENT_PATTERN.test(argument))) {
    throw new MarketingOpsError('INVALID_INPUT', 'Secret command-line arguments are not accepted');
  }
  if (Object.keys(env).some((name) => SECRET_ENV_PATTERN.test(name))) {
    throw new MarketingOpsError('INVALID_INPUT', 'Secret environment variables are not accepted');
  }
  const channel = argv[1] as AutomaticChannel | undefined;
  if (channel && AUTOMATIC_CHANNELS.includes(channel)) {
    const plan = planChannelSetup(channel);
    if (plan.secretInput === 'hidden-tty' && !stdinIsTty) {
      throw new MarketingOpsError('INVALID_INPUT', 'A secure interactive TTY is required');
    }
  }
}

export interface InternalChannelStatus {
  id: AutomaticChannel;
  alias: string | null;
  health: 'ready' | 'not-configured' | 'reauth-required' | 'blocked';
  nextAction: string | null;
  secretRef?: string;
  profilePath?: string;
}

export function createPublicChannelStatus(status: InternalChannelStatus) {
  return {
    channel: status.id,
    alias: status.alias,
    health: status.health,
    nextAction: status.nextAction,
  };
}
