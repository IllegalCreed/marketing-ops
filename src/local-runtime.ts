import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubActivationStore } from './activation-store.js';
import { BlueskyActivationStore } from './bluesky-activation-store.js';
import { DevActivationStore } from './dev-activation-store.js';
import { BlueskyChannelController, type PublicBlueskyChannelStatus } from './bluesky-channel.js';
import { AdapterError } from './adapters/contract.js';
import { BlueskyApiClient, type BlueskyCredentials } from './adapters/bluesky-api.js';
import { DevApiClient } from './adapters/dev-api.js';
import { MastodonApiClient, type MastodonCredentials } from './adapters/mastodon-api.js';
import { GitHubCliClient } from './adapters/github-cli.js';
import { WeiboCliClient } from './adapters/weibo-cli.js';
import { DevChannelController, type PublicDevChannelStatus } from './dev-channel.js';
import { DevCollector, type DevObservabilityClient } from './dev-observability.js';
import { GitHubChannelController, type PublicGitHubChannelStatus } from './github-channel.js';
import { MastodonChannelController, type PublicMastodonChannelStatus } from './mastodon-channel.js';
import { MastodonCollector, type MastodonObservabilityClient } from './mastodon-observability.js';
import { MastodonActivationStore } from './mastodon-activation-store.js';
import { assertSafeToolInput, TOOL_INPUT_SCHEMAS } from './contract.js';
import { MarketingOpsError } from './errors.js';
import { GitHubCollector, type GitHubObservabilityClient } from './github-observability.js';
import { PublishService, type ReceiptRepository } from './publish-service.js';
import { ReceiptStore, type PublicPostRef, type PublishReceipt } from './receipt-store.js';
import { createRuntimeToolHandler } from './runtime-handler.js';
import { MacOsKeychainSecretStore } from './security/secret-store.js';
import { defaultChannelStatuses, type MarketingToolHandler } from './server-factory.js';
import { WeiboChannelController, type PublicWeiboChannelStatus } from './weibo-channel.js';

export const GITHUB_REPOSITORY = 'IllegalCreed/algorithms-visualization';
const KEYCHAIN_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'keychain-helper');

interface GitHubRuntimeController {
  getStatus(): Promise<PublicGitHubChannelStatus>;
  createRegistration(): ReturnType<GitHubChannelController['createRegistration']>;
  createEnabledClient(): Promise<GitHubObservabilityClient | null>;
}

interface RuntimeReceiptRepository extends ReceiptRepository {
  listByCampaign(campaignId: string): Promise<PublishReceipt[]>;
  findKnownPostRef(postRef: PublicPostRef): Promise<PublishReceipt | null>;
  findByPostRef(campaignId: string, postRef: PublicPostRef): Promise<PublishReceipt | null>;
  markDeleted(idempotencyKey: string): Promise<PublishReceipt>;
}

interface BlueskyRuntimeController {
  getStatus(): Promise<PublicBlueskyChannelStatus>;
  createRegistration(): ReturnType<BlueskyChannelController['createRegistration']>;
}

interface DevRuntimeController {
  getStatus(): Promise<PublicDevChannelStatus>;
  createRegistration(): ReturnType<DevChannelController['createRegistration']>;
  createEnabledClient(): Promise<DevObservabilityClient | null>;
}

interface MastodonRuntimeController {
  getStatus(): Promise<PublicMastodonChannelStatus>;
  createRegistration(): ReturnType<MastodonChannelController['createRegistration']>;
  createEnabledClient(): Promise<MastodonObservabilityClient | null>;
}

interface LocalRuntimeOptions {
  github: GitHubRuntimeController;
  weibo?: { getStatus(): Promise<PublicWeiboChannelStatus> };
  bluesky?: BlueskyRuntimeController;
  dev?: DevRuntimeController;
  mastodon?: MastodonRuntimeController;
  receipts: RuntimeReceiptRepository;
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

function blockedBlueskyStatus(): PublicBlueskyChannelStatus {
  return {
    channel: 'bluesky',
    alias: null,
    health: 'blocked',
    adapterReady: false,
    nextAction: 'Run marketing-ops doctor',
  };
}

function blockedDevStatus(): PublicDevChannelStatus {
  return {
    channel: 'dev',
    alias: null,
    health: 'blocked',
    adapterReady: false,
    nextAction: 'Run marketing-ops doctor',
  };
}

function blockedMastodonStatus(): PublicMastodonChannelStatus {
  return {
    channel: 'mastodon',
    alias: null,
    health: 'blocked',
    adapterReady: false,
    nextAction: 'Run marketing-ops doctor',
  };
}

export function createLocalRuntimeToolHandler(options: LocalRuntimeOptions): MarketingToolHandler {
  const publishHandler = createRuntimeToolHandler({
    publish: async (input) => {
      const request = TOOL_INPUT_SCHEMAS.publish_campaign.parse(input);
      const channels = new Set(request.packages.map((packageValue) => packageValue.channel));
      const registrations = [];
      if (channels.has('github')) registrations.push(await options.github.createRegistration());
      if (channels.has('bluesky') && options.bluesky) {
        registrations.push(await options.bluesky.createRegistration());
      }
      if (channels.has('dev') && options.dev) {
        registrations.push(await options.dev.createRegistration());
      }
      if (channels.has('mastodon') && options.mastodon) {
        registrations.push(await options.mastodon.createRegistration());
      }
      return new PublishService({
        registrations: registrations.filter((registration) => registration !== null),
        receipts: options.receipts,
      }).publish(request);
    },
  });

  return async (name, input) => {
    if (name === 'publish_campaign' || name === 'reply_feedback') {
      return publishHandler(name, input);
    }
    try {
      assertSafeToolInput(input);
      if (name === 'channels_status') {
        TOOL_INPUT_SCHEMAS.channels_status.parse(input);
        let github: PublicGitHubChannelStatus;
        let weibo: PublicWeiboChannelStatus | null = null;
        let bluesky: PublicBlueskyChannelStatus | null = null;
        let dev: PublicDevChannelStatus | null = null;
        let mastodon: PublicMastodonChannelStatus | null = null;
        try {
          github = await options.github.getStatus();
        } catch {
          github = blockedGitHubStatus();
        }
        if (options.weibo) {
          try {
            weibo = await options.weibo.getStatus();
          } catch {
            weibo = {
              channel: 'weibo',
              alias: null,
              health: 'blocked',
              adapterReady: false,
              nextAction: 'Run marketing-ops doctor',
            };
          }
        }
        if (options.bluesky) {
          try {
            bluesky = await options.bluesky.getStatus();
          } catch {
            bluesky = blockedBlueskyStatus();
          }
        }
        if (options.dev) {
          try {
            dev = await options.dev.getStatus();
          } catch {
            dev = blockedDevStatus();
          }
        }
        if (options.mastodon) {
          try {
            mastodon = await options.mastodon.getStatus();
          } catch {
            mastodon = blockedMastodonStatus();
          }
        }
        const channels = defaultChannelStatuses().map((status) => {
          if (status.channel === 'github') return github;
          if (status.channel === 'weibo' && weibo) return weibo;
          if (status.channel === 'bluesky' && bluesky) return bluesky;
          if (status.channel === 'dev' && dev) return dev;
          if (status.channel === 'mastodon' && mastodon) return mastodon;
          return status;
        });
        return { data: { contractVersion: 2, channels } };
      }
      if (name === 'get_publish_status') {
        const request = TOOL_INPUT_SCHEMAS.get_publish_status.parse(input);
        const receipts = await options.receipts.listByCampaign(request.campaignId);
        const status =
          receipts.length === 0
            ? 'not-found'
            : receipts.some((receipt) => receipt.status === 'queued')
              ? 'in-progress'
              : 'complete';
        return { data: { campaignId: request.campaignId, status, receipts, failures: [] } };
      }
      if (name === 'list_feedback') {
        const request = TOOL_INPUT_SCHEMAS.list_feedback.parse(input);
        if (
          request.postRef.channel !== 'github' &&
          request.postRef.channel !== 'dev' &&
          request.postRef.channel !== 'mastodon'
        ) {
          return unavailableOperation();
        }
        const postRef = request.postRef;
        const receipt = await options.receipts.findKnownPostRef(postRef);
        if (!receipt) {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post receipt was not found');
        }
        if (receipt.status !== 'published') {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post is not published');
        }
        if (postRef.channel === 'github') {
          const collector = await enabledCollector(options.github);
          return { data: await collector.listFeedback(postRef, request.cursor) };
        }
        if (postRef.channel === 'mastodon') {
          if (!options.mastodon) return unavailableOperation();
          const collector = await enabledMastodonCollector(options.mastodon);
          return { data: await collector.listFeedback(postRef) };
        }
        if (!options.dev) return unavailableOperation();
        const collector = await enabledDevCollector(options.dev);
        return { data: await collector.listFeedback(postRef, request.cursor) };
      }
      if (name === 'get_campaign_report') {
        const request = TOOL_INPUT_SCHEMAS.get_campaign_report.parse(input);
        const receipts = (await options.receipts.listByCampaign(request.campaignId)).filter(
          (receipt) =>
            receipt.status === 'published' &&
            ((receipt.channel === 'github' && receipt.publicUrl.includes('/releases/')) ||
              receipt.channel === 'dev' ||
              receipt.channel === 'mastodon'),
        );
        if (receipts.length === 0) {
          return {
            data: {
              campaignId: request.campaignId,
              window: request.window,
              status: 'unavailable',
              reason: 'No published observable receipt was found',
            },
          };
        }
        const channels = [];
        for (const receipt of receipts) {
          if (receipt.channel === 'github') {
            channels.push(await (await enabledCollector(options.github)).collect(receipt));
          } else if (receipt.channel === 'mastodon') {
            if (!options.mastodon) return unavailableOperation();
            channels.push(
              await (await enabledMastodonCollector(options.mastodon)).collect(receipt),
            );
          } else {
            if (!options.dev) return unavailableOperation();
            channels.push(await (await enabledDevCollector(options.dev)).collect(receipt));
          }
        }
        return {
          data: {
            campaignId: request.campaignId,
            window: request.window,
            status: 'available',
            channels,
          },
        };
      }
      if (name === 'delete_post') {
        const request = TOOL_INPUT_SCHEMAS.delete_post.parse(input);
        const receipt = await options.receipts.findByPostRef(request.campaignId, request.postRef);
        if (!receipt) {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post receipt was not found');
        }
        if (receipt.status === 'deleted') {
          return { data: { campaignId: request.campaignId, status: 'already-deleted' } };
        }
        if (receipt.status !== 'published') {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post is not published');
        }
        const registration =
          receipt.channel === 'github'
            ? await options.github.createRegistration()
            : receipt.channel === 'bluesky' && options.bluesky
              ? await options.bluesky.createRegistration()
              : receipt.channel === 'mastodon' && options.mastodon
                ? await options.mastodon.createRegistration()
                : null;
        if (
          !registration ||
          !registration.enabled ||
          registration.health !== 'ready' ||
          registration.adapter.definition.channel !== receipt.channel ||
          !registration.adapter.definition.capabilities.delete ||
          !registration.adapter.delete
        ) {
          return unavailableOperation();
        }
        const result = await registration.adapter.delete(receipt);
        await options.receipts.markDeleted(receipt.idempotencyKey);
        return { data: { campaignId: request.campaignId, status: result.status } };
      }
      return unavailableOperation();
    } catch (error) {
      return operationError(error);
    }
  };
}

function unavailableOperation() {
  return {
    isError: true,
    data: { code: 'ADAPTER_UNAVAILABLE', message: 'No enabled platform adapter is configured' },
  };
}

function operationError(error: unknown) {
  if (error instanceof AdapterError || error instanceof MarketingOpsError) {
    return { isError: true, data: error.toJSON() };
  }
  return {
    isError: true,
    data: { code: 'ADAPTER_UNAVAILABLE', message: 'Platform operation failed closed' },
  };
}

async function enabledCollector(github: GitHubRuntimeController): Promise<GitHubCollector> {
  const client = await github.createEnabledClient();
  if (!client) {
    throw new MarketingOpsError('ADAPTER_UNAVAILABLE', 'GitHub adapter is not enabled and ready');
  }
  return new GitHubCollector({ client, repository: GITHUB_REPOSITORY });
}

async function enabledDevCollector(dev: DevRuntimeController): Promise<DevCollector> {
  const client = await dev.createEnabledClient();
  if (!client) {
    throw new MarketingOpsError('ADAPTER_UNAVAILABLE', 'DEV adapter is not enabled and ready');
  }
  return new DevCollector({ client });
}

async function enabledMastodonCollector(
  mastodon: MastodonRuntimeController,
): Promise<MastodonCollector> {
  const client = await mastodon.createEnabledClient();
  if (!client) {
    throw new MarketingOpsError('ADAPTER_UNAVAILABLE', 'Mastodon adapter is not enabled and ready');
  }
  return new MastodonCollector({ client });
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

export function createDefaultWeiboController(): WeiboChannelController {
  return new WeiboChannelController({ client: new WeiboCliClient() });
}

export function createDefaultBlueskyClient(credentials: BlueskyCredentials): BlueskyApiClient {
  return new BlueskyApiClient({ credentials });
}

export function createDefaultBlueskyController(
  root: string = marketingOpsDataRoot(),
): BlueskyChannelController {
  return new BlueskyChannelController({
    clients: createDefaultBlueskyClient,
    activations: new BlueskyActivationStore(root),
    secrets: new MacOsKeychainSecretStore(KEYCHAIN_HELPER),
  });
}

export function createDefaultDevClient(apiKey: string): DevApiClient {
  return new DevApiClient({ apiKey });
}

export function createDefaultMastodonClient(credentials: MastodonCredentials): MastodonApiClient {
  return new MastodonApiClient({ credentials });
}

export function createDefaultDevController(
  root: string = marketingOpsDataRoot(),
): DevChannelController {
  return new DevChannelController({
    clients: createDefaultDevClient,
    activations: new DevActivationStore(root),
    secrets: new MacOsKeychainSecretStore(KEYCHAIN_HELPER),
  });
}

export function createDefaultMastodonController(
  root: string = marketingOpsDataRoot(),
): MastodonChannelController {
  return new MastodonChannelController({
    clients: createDefaultMastodonClient,
    activations: new MastodonActivationStore(root),
    secrets: new MacOsKeychainSecretStore(KEYCHAIN_HELPER),
  });
}

export function createDefaultLocalRuntimeToolHandler(
  root: string = marketingOpsDataRoot(),
): MarketingToolHandler {
  return createLocalRuntimeToolHandler({
    github: createDefaultGitHubController(root),
    weibo: createDefaultWeiboController(),
    bluesky: createDefaultBlueskyController(root),
    dev: createDefaultDevController(root),
    mastodon: createDefaultMastodonController(root),
    receipts: new ReceiptStore(root),
  });
}
