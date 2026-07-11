import { homedir } from 'node:os';
import { join } from 'node:path';
import { GitHubActivationStore } from './activation-store.js';
import { GitHubCliClient } from './adapters/github-cli.js';
import { GitHubChannelController, type PublicGitHubChannelStatus } from './github-channel.js';
import { PublishService, type ReceiptRepository } from './publish-service.js';
import { ReceiptStore } from './receipt-store.js';
import { createRuntimeToolHandler } from './runtime-handler.js';
import { defaultChannelStatuses, type MarketingToolHandler } from './server-factory.js';

export const GITHUB_REPOSITORY = 'IllegalCreed/algorithms-visualization';

interface GitHubRuntimeController {
  getStatus(): Promise<PublicGitHubChannelStatus>;
  createRegistration(): ReturnType<GitHubChannelController['createRegistration']>;
}

interface LocalRuntimeOptions {
  github: GitHubRuntimeController;
  receipts: ReceiptRepository;
}

function blockedGitHubStatus(): PublicGitHubChannelStatus {
  return {
    channel: 'github',
    alias: null,
    health: 'blocked',
    adapterReady: false,
    nextAction: 'Run marketing-ops setup github',
  };
}

export function createLocalRuntimeToolHandler(options: LocalRuntimeOptions): MarketingToolHandler {
  const publishHandler = createRuntimeToolHandler({
    publish: async (input) => {
      const registration = await options.github.createRegistration();
      return new PublishService({
        registrations: registration ? [registration] : [],
        receipts: options.receipts,
      }).publish(input);
    },
  });

  return async (name, input) => {
    if (name !== 'channels_status') return publishHandler(name, input);
    let github: PublicGitHubChannelStatus;
    try {
      github = await options.github.getStatus();
    } catch {
      github = blockedGitHubStatus();
    }
    const channels = defaultChannelStatuses().map((status) =>
      status.channel === 'github' ? github : status,
    );
    return { data: { contractVersion: 2, channels } };
  };
}

export function marketingOpsDataRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'marketing-ops');
}

export function createDefaultGitHubController(
  root: string = marketingOpsDataRoot(),
): GitHubChannelController {
  const client = new GitHubCliClient();
  return new GitHubChannelController({
    client,
    activations: new GitHubActivationStore(root, GITHUB_REPOSITORY),
    repository: GITHUB_REPOSITORY,
  });
}

export function createDefaultLocalRuntimeToolHandler(
  root: string = marketingOpsDataRoot(),
): MarketingToolHandler {
  return createLocalRuntimeToolHandler({
    github: createDefaultGitHubController(root),
    receipts: new ReceiptStore(root),
  });
}
