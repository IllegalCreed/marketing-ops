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
import { createDefaultGitHubController, createDefaultWeiboController } from './local-runtime.js';
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
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(wasRaw));
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

async function runSetup(channelInput?: AutomaticChannel): Promise<void> {
  assertSecureSetupInvocation(
    ['setup', ...(channelInput ? [channelInput] : [])],
    relevantEnvironment(),
    Boolean(process.stdin.isTTY),
  );
  const channel = channelInput ?? (await chooseChannel());
  const plan = planChannelSetup(channel);
  process.stdout.write(`Setting up ${plan.label} with ${plan.method}.\n`);

  if (channel === 'github') {
    const status = await createDefaultGitHubController().enable();
    process.stdout.write(
      `GitHub ${status.alias ?? 'account'} is ready. The adapter is enabled for owner-authorized campaigns.\n`,
    );
    return;
  }
  if (plan.secretInput === 'official-browser') {
    process.stdout.write(
      channel === 'weibo'
        ? 'Weibo OAuth remains closed until the Free command catalog can be frozen safely.\n'
        : 'Official OAuth/device authorization will open here when its T3 adapter lands.\n',
    );
    return;
  }

  const alias = channel === 'bluesky' ? await promptVisible('Public account handle: ') : null;
  const value = await promptHidden(
    channel === 'bluesky' ? 'Dedicated App Password: ' : 'DEV API key: ',
  );
  const store = new MacOsKeychainSecretStore(KEYCHAIN_HELPER);
  await store.put(`channel/${channel}/${plan.method}`, value);
  if (alias) await store.put(`channel/${channel}/alias`, alias);
  process.stdout.write(
    'Authorization saved in macOS Keychain. The adapter remains disabled until T3.\n',
  );
}

async function renderStatuses(): Promise<string> {
  const [github, weibo] = await Promise.all([
    createDefaultGitHubController().getStatus(),
    createDefaultWeiboController().getStatus(),
  ]);
  return CHANNEL_SETUP_CATALOG.map((channel) => {
    if (channel.id === 'github') {
      const readiness = github.adapterReady ? 'enabled' : 'setup-required';
      return `${channel.label.padEnd(14)} ${github.health.padEnd(15)} ${readiness}`;
    }
    if (channel.id === 'weibo') {
      return `${channel.label.padEnd(14)} ${weibo.health.padEnd(15)} ${weibo.nextAction}`;
    }
    return `${channel.label.padEnd(14)} not-configured  Run marketing-ops setup ${channel.id}`;
  }).join('\n');
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.command === 'help') process.stdout.write(`${renderCliHelp()}\n`);
  else if (options.command === 'setup') await runSetup(options.channel);
  else if (options.command === 'status') process.stdout.write(`${await renderStatuses()}\n`);
  else {
    await access(KEYCHAIN_HELPER);
    const [github, weibo] = await Promise.all([
      createDefaultGitHubController().getStatus(),
      createDefaultWeiboController().getStatus(),
    ]);
    process.stdout.write(
      `Keychain helper: ready\nPrivate data root: ready\nMCP transport: stdio\nGitHub CLI: ${github.health}\nGitHub adapter: ${github.adapterReady ? 'enabled' : 'disabled'}\nWeibo CLI: ${weibo.health}\nWeibo adapter: disabled\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof MarketingOpsError ? `${error.code}: ${error.message}` : 'UNKNOWN';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
