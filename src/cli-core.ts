import { AUTOMATIC_CHANNELS, type AutomaticChannel } from './onboarding.js';
import { MarketingOpsError } from './errors.js';

export type CliOptions =
  | { command: 'help' }
  | { command: 'setup'; channel?: AutomaticChannel }
  | { command: 'status' }
  | { command: 'doctor' };

const FORBIDDEN_ARGUMENT =
  /--?(api.?key|app.?password|cookie|credential|json|password|profile|secret|storage.?state|token)/i;

export function parseCliArgs(argv: readonly string[]): CliOptions {
  if (argv.some((argument) => FORBIDDEN_ARGUMENT.test(argument))) {
    throw new MarketingOpsError(
      'INVALID_INPUT',
      'Secret values and JSON configuration are not accepted on the command line',
    );
  }
  const [command = 'help', channel, ...rest] = argv;
  if (rest.length > 0) throw new MarketingOpsError('INVALID_INPUT', 'Unexpected CLI arguments');
  if (command === 'help' || command === '--help' || command === '-h') return { command: 'help' };
  if (command === 'status') {
    if (channel) throw new MarketingOpsError('INVALID_INPUT', 'status takes no arguments');
    return { command: 'status' };
  }
  if (command === 'doctor') {
    if (channel) throw new MarketingOpsError('INVALID_INPUT', 'doctor takes no arguments');
    return { command: 'doctor' };
  }
  if (command !== 'setup')
    throw new MarketingOpsError('INVALID_INPUT', `Unknown command: ${command}`);
  if (!channel) return { command: 'setup' };
  if (!AUTOMATIC_CHANNELS.includes(channel as AutomaticChannel)) {
    throw new MarketingOpsError('INVALID_INPUT', `Unsupported setup channel: ${channel}`);
  }
  return { command: 'setup', channel: channel as AutomaticChannel };
}

export function renderCliHelp(): string {
  return `Marketing Ops local setup\n\nCommands:\n  marketing-ops setup [channel]  Guided one-time authorization\n  marketing-ops status           Sanitized channel status\n  marketing-ops doctor           Local health checks\n\nDaily campaigns are requested in Codex after setup; you do not edit JSON or build links manually. Never paste a password, token, Cookie, or browser Profile into this command or chat.`;
}
