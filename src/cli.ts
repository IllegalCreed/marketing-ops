#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseCliArgs, renderCliHelp } from './cli-core.js';
import {
  assertSecureSetupInvocation,
  AUTOMATIC_CHANNELS,
  CHANNEL_SETUP_CATALOG,
  planChannelSetup,
  type AutomaticChannel,
} from './onboarding.js';
import { MarketingOpsError } from './errors.js';
import {
  createDefaultBlueskyController,
  createDefaultDevController,
  createDefaultGitHubController,
  createDefaultMastodonController,
  createDefaultWeiboController,
  marketingOpsDataRoot,
} from './local-runtime.js';
import { ProjectProfileStore, type ProjectProfile } from './project-profile-store.js';
import { MacOsKeychainSecretStore } from './security/secret-store.js';

const KEYCHAIN_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'keychain-helper');

function relevantEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(MARKETING_OPS_|BLUESKY_|DEV_|MASTODON_|WEIBO_)/.test(name),
    ),
  );
}

async function promptVisible(message: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(message)).trim();
  } finally {
    readline.close();
  }
}

async function promptHidden(message: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new MarketingOpsError('INVALID_INPUT', 'A secure interactive TTY is required');
  }
  process.stdout.write(message);
  const wasRaw = process.stdin.isRaw;
  const wasPaused = process.stdin.isPaused();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      if (wasPaused) process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new MarketingOpsError('INVALID_INPUT', 'Setup cancelled'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) value = value.slice(0, -1);
        else if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
      }
    };
    process.stdin.on('data', onData);
  });
}

async function chooseChannel(): Promise<AutomaticChannel> {
  process.stdout.write(
    `${CHANNEL_SETUP_CATALOG.map((channel, index) => `${index + 1}. ${channel.label}`).join('\n')}\n`,
  );
  const answer = await promptVisible('Choose a channel: ');
  const channel = AUTOMATIC_CHANNELS[Number(answer) - 1];
  if (!channel) throw new MarketingOpsError('INVALID_INPUT', 'Invalid channel selection');
  return channel;
}

function projectStore(): ProjectProfileStore {
  return new ProjectProfileStore(marketingOpsDataRoot());
}

async function resolveProject(projectId?: string): Promise<ProjectProfile> {
  const store = projectStore();
  if (projectId) return store.require(projectId);
  const projects = await store.list();
  if (projects.length === 1) return projects[0]!;
  throw new MarketingOpsError(
    'INVALID_INPUT',
    projects.length === 0
      ? 'Register a project with marketing-ops project add'
      : 'Select a project with --project <project-id>',
  );
}

function commaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function runProjectAdd(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new MarketingOpsError('INVALID_INPUT', 'A secure interactive TTY is required');
  }
  const id = await promptVisible('Project ID (lowercase-kebab-case): ');
  const displayName = await promptVisible('Project display name: ');
  const canonicalOrigins = commaSeparated(await promptVisible('HTTPS origins (comma separated): '));
  const channels = commaSeparated(await promptVisible('Enabled channels (comma separated): '));
  const github = channels.includes('github')
    ? { repository: await promptVisible('GitHub repository (owner/name): ') }
    : undefined;
  const dev = channels.includes('dev')
    ? { tags: commaSeparated(await promptVisible('DEV tags (1-4, comma separated): ')) }
    : undefined;
  const profile = await projectStore().save({
    schemaVersion: 1,
    id,
    displayName,
    canonicalOrigins,
    channels,
    ...(github ? { github } : {}),
    ...(dev ? { dev } : {}),
  });
  process.stdout.write(`Project ${profile.id} is registered and ready for local campaigns.\n`);
}

async function renderProjects(): Promise<string> {
  const projects = await projectStore().list();
  if (projects.length === 0) return 'No projects are registered.';
  return projects
    .map(
      (project) =>
        `${project.id.padEnd(24)} ${project.displayName}  ${project.canonicalOrigins.join(', ')}`,
    )
    .join('\n');
}

async function renderProject(projectId: string): Promise<string> {
  const project = await projectStore().require(projectId);
  return [
    `Project: ${project.id}`,
    `Name: ${project.displayName}`,
    `Origins: ${project.canonicalOrigins.join(', ')}`,
    `Channels: ${project.channels.join(', ')}`,
    `GitHub: ${project.github?.repository ?? 'disabled'}`,
    `DEV tags: ${project.dev?.tags.join(', ') ?? 'disabled'}`,
  ].join('\n');
}

async function runSetup(channelInput?: AutomaticChannel, projectId?: string): Promise<void> {
  assertSecureSetupInvocation(
    [
      'setup',
      ...(channelInput ? [channelInput] : []),
      ...(projectId ? ['--project', projectId] : []),
    ],
    relevantEnvironment(),
    Boolean(process.stdin.isTTY),
  );
  const channel = channelInput ?? (await chooseChannel());
  const plan = planChannelSetup(channel);
  process.stdout.write(`Setting up ${plan.label} with ${plan.method}.\n`);

  if (channel === 'github') {
    const project = await resolveProject(projectId);
    const status = await createDefaultGitHubController(project).enable();
    process.stdout.write(
      `GitHub ${status.alias ?? 'account'} is ready. The adapter is enabled for owner-authorized campaigns.\n`,
    );
    return;
  }
  if (projectId) await projectStore().require(projectId);
  if (channel === 'bluesky') {
    const handle = await promptVisible('Public account handle: ');
    const appPassword = await promptHidden('Dedicated App Password: ');
    const status = await createDefaultBlueskyController().enable({ handle, appPassword });
    process.stdout.write(
      `Bluesky ${status.alias ?? 'account'} is ready. The adapter is enabled for owner-authorized campaigns.\n`,
    );
    return;
  }
  if (channel === 'dev') {
    const apiKey = await promptHidden('DEV API key: ');
    const status = await createDefaultDevController().enable(apiKey);
    process.stdout.write(
      `DEV ${status.alias ?? 'account'} is ready. The adapter is enabled for owner-authorized campaigns.\n`,
    );
    return;
  }
  if (channel === 'mastodon') {
    const instanceUrl = await promptVisible('Mastodon instance URL: ');
    const accessToken = await promptHidden('Mastodon access token: ');
    const status = await createDefaultMastodonController().enable({ instanceUrl, accessToken });
    process.stdout.write(
      `Mastodon ${status.alias ?? 'account'} is ready. The adapter is enabled for owner-authorized campaigns.\n`,
    );
    return;
  }
  if (plan.secretInput === 'official-browser') {
    process.stdout.write(
      channel === 'weibo'
        ? 'Weibo Free is read-only; publishing remains disabled.\n'
        : 'Official OAuth/device authorization will open here when its T3 adapter lands.\n',
    );
    return;
  }

  const value = await promptHidden('Channel credential: ');
  const store = new MacOsKeychainSecretStore(KEYCHAIN_HELPER);
  await store.put(`channel/${channel}/${plan.method}`, value);
  process.stdout.write(
    'Authorization saved in macOS Keychain. The adapter remains disabled until T3.\n',
  );
}

async function renderStatuses(projectId?: string): Promise<string> {
  const project = await resolveProject(projectId);
  const [github, weibo, bluesky, dev, mastodon] = await Promise.all([
    project.channels.includes('github')
      ? createDefaultGitHubController(project).getStatus()
      : Promise.resolve({
          channel: 'github' as const,
          alias: null,
          health: 'blocked' as const,
          adapterReady: false,
          nextAction: 'Enable GitHub in the project profile',
        }),
    project.channels.includes('weibo')
      ? createDefaultWeiboController().getStatus()
      : Promise.resolve(null),
    project.channels.includes('bluesky')
      ? createDefaultBlueskyController().getStatus()
      : Promise.resolve(null),
    project.channels.includes('dev')
      ? createDefaultDevController().getStatus()
      : Promise.resolve(null),
    project.channels.includes('mastodon')
      ? createDefaultMastodonController().getStatus()
      : Promise.resolve(null),
  ]);
  return [
    `Project ${project.id}`,
    ...CHANNEL_SETUP_CATALOG.map((channel) => {
      if (!project.channels.includes(channel.id)) {
        return `${channel.label.padEnd(14)} disabled        Enable in project profile`;
      }
      if (channel.id === 'github') {
        const readiness = github.adapterReady ? 'enabled' : 'setup-required';
        return `${channel.label.padEnd(14)} ${github.health.padEnd(15)} ${readiness}`;
      }
      if (channel.id === 'weibo') {
        return `${channel.label.padEnd(14)} ${weibo!.health.padEnd(15)} ${weibo!.nextAction}`;
      }
      if (channel.id === 'bluesky') {
        const readiness = bluesky!.adapterReady ? 'enabled' : 'setup-required';
        return `${channel.label.padEnd(14)} ${bluesky!.health.padEnd(15)} ${readiness}`;
      }
      if (channel.id === 'dev') {
        const readiness = dev!.adapterReady ? 'enabled' : 'setup-required';
        return `${channel.label.padEnd(14)} ${dev!.health.padEnd(15)} ${readiness}`;
      }
      if (channel.id === 'mastodon') {
        const readiness = mastodon!.adapterReady ? 'enabled' : 'setup-required';
        return `${channel.label.padEnd(14)} ${mastodon!.health.padEnd(15)} ${readiness}`;
      }
      const fallback = channel as { label: string; id: string };
      return `${fallback.label.padEnd(14)} not-configured  Run marketing-ops setup ${fallback.id}`;
    }),
  ].join('\n');
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.command === 'help') process.stdout.write(`${renderCliHelp()}\n`);
  else if (options.command === 'project-add') await runProjectAdd();
  else if (options.command === 'project-list') process.stdout.write(`${await renderProjects()}\n`);
  else if (options.command === 'project-show') {
    process.stdout.write(`${await renderProject(options.projectId)}\n`);
  } else if (options.command === 'setup') {
    await runSetup(options.channel, options.projectId);
  } else if (options.command === 'status') {
    process.stdout.write(`${await renderStatuses(options.projectId)}\n`);
  } else {
    await access(KEYCHAIN_HELPER);
    const project = await resolveProject(options.projectId);
    const [github, weibo, bluesky, dev, mastodon] = await Promise.all([
      project.channels.includes('github')
        ? createDefaultGitHubController(project).getStatus()
        : Promise.resolve({
            channel: 'github' as const,
            alias: null,
            health: 'blocked' as const,
            adapterReady: false,
            nextAction: 'Enable GitHub in the project profile',
          }),
      createDefaultWeiboController().getStatus(),
      createDefaultBlueskyController().getStatus(),
      createDefaultDevController().getStatus(),
      createDefaultMastodonController().getStatus(),
    ]);
    process.stdout.write(
      `Project: ${project.id}\nKeychain helper: ready\nPrivate data root: ready\nMCP transport: stdio\nGitHub CLI: ${github.health}\nGitHub adapter: ${github.adapterReady ? 'enabled' : 'disabled'}\nWeibo CLI: ${weibo.health}\nWeibo adapter: disabled\nBluesky API: ${bluesky.health}\nBluesky adapter: ${bluesky.adapterReady ? 'enabled' : 'disabled'}\nDEV API: ${dev.health}\nDEV adapter: ${dev.adapterReady ? 'enabled' : 'disabled'}\nMastodon API: ${mastodon.health}\nMastodon adapter: ${mastodon.adapterReady ? 'enabled' : 'disabled'}\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof MarketingOpsError ? `${error.code}: ${error.message}` : 'UNKNOWN';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
