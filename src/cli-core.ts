import { MarketingOpsError } from './errors.js';
import { AUTOMATIC_CHANNELS, type AutomaticChannel } from './onboarding.js';

export type CliOptions =
  | { command: 'help' }
  | { command: 'setup'; channel?: AutomaticChannel; projectId?: string }
  | { command: 'status'; projectId?: string }
  | { command: 'doctor'; projectId?: string }
  | { command: 'project-add' }
  | { command: 'project-list' }
  | { command: 'project-show'; projectId: string };

const FORBIDDEN_ARGUMENT =
  /--?(api.?key|app.?password|cookie|credential|json|password|profile(?:-path)?|secret|storage.?state|token)/i;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function parseProjectOption(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== '--project' || !PROJECT_ID_PATTERN.test(args[1] ?? '')) {
    throw new MarketingOpsError(
      'INVALID_INPUT',
      'Expected --project followed by a valid project ID',
    );
  }
  return args[1];
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  if (argv.some((argument) => FORBIDDEN_ARGUMENT.test(argument))) {
    throw new MarketingOpsError(
      'INVALID_INPUT',
      'Secret values and JSON configuration are not accepted on the command line',
    );
  }
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    if (args.length > 0) throw new MarketingOpsError('INVALID_INPUT', 'help takes no arguments');
    return { command: 'help' };
  }
  if (command === 'project') {
    const [action, projectId, ...rest] = args;
    if (action === 'add' && !projectId) return { command: 'project-add' };
    if (action === 'list' && !projectId) return { command: 'project-list' };
    if (action === 'show' && projectId && PROJECT_ID_PATTERN.test(projectId) && rest.length === 0) {
      return { command: 'project-show', projectId };
    }
    throw new MarketingOpsError(
      'INVALID_INPUT',
      'Use project add, project list, or project show <project-id>',
    );
  }
  if (command === 'status' || command === 'doctor') {
    const projectId = parseProjectOption(args);
    return projectId ? { command, projectId } : { command };
  }
  if (command !== 'setup') {
    throw new MarketingOpsError('INVALID_INPUT', `Unknown command: ${command}`);
  }
  const [channel, ...rest] = args;
  if (!channel) return { command: 'setup' };
  if (!AUTOMATIC_CHANNELS.includes(channel as AutomaticChannel)) {
    throw new MarketingOpsError('INVALID_INPUT', `Unsupported setup channel: ${channel}`);
  }
  const projectId = parseProjectOption(rest);
  return projectId
    ? { command: 'setup', channel: channel as AutomaticChannel, projectId }
    : { command: 'setup', channel: channel as AutomaticChannel };
}

export function renderCliHelp(): string {
  return `Marketing Ops local setup

Commands:
  marketing-ops project add                  Guided project registration
  marketing-ops project list                 List registered projects
  marketing-ops project show <project-id>    Show one non-secret profile
  marketing-ops setup [channel] [--project <project-id>]
                                             Guided one-time authorization
  marketing-ops status [--project <project-id>]
                                             Sanitized project/channel status
  marketing-ops doctor [--project <project-id>]
                                             Local health checks

Daily campaigns are requested in Codex after setup; you do not edit JSON or build links manually. Never paste a password, token, Cookie, or browser Profile into this command or chat.`;
}
