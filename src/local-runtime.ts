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
import { assertSafeToolInput, CONTRACT_VERSION, TOOL_INPUT_SCHEMAS } from './contract.js';
import { MarketingOpsError } from './errors.js';
import { GitHubCollector, type GitHubObservabilityClient } from './github-observability.js';
import { PublishService, type ReceiptRepository } from './publish-service.js';
import { ReceiptStore, type PublicPostRef, type PublishReceipt } from './receipt-store.js';
import { createRuntimeToolHandler } from './runtime-handler.js';
import { assertProjectPublishRequest } from './project-policy.js';
import { ProjectProfileStore, type ProjectProfile } from './project-profile-store.js';
import { MacOsKeychainSecretStore } from './security/secret-store.js';
import { defaultChannelStatuses, type MarketingToolHandler } from './server-factory.js';
import { WeiboChannelController, type PublicWeiboChannelStatus } from './weibo-channel.js';

const KEYCHAIN_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'keychain-helper');

interface GitHubRuntimeController {
  getStatus(): Promise<PublicGitHubChannelStatus>;
  createRegistration(): ReturnType<GitHubChannelController['createRegistration']>;
  createEnabledClient(): Promise<GitHubObservabilityClient | null>;
}

interface RuntimeReceiptRepository extends ReceiptRepository {
  listByCampaign(projectId: string, campaignId: string): Promise<PublishReceipt[]>;
  findKnownPostRef(projectId: string, postRef: PublicPostRef): Promise<PublishReceipt | null>;
  findByPostRef(
    projectId: string,
    campaignId: string,
    postRef: PublicPostRef,
  ): Promise<PublishReceipt | null>;
  markDeleted(projectId: string, idempotencyKey: string): Promise<PublishReceipt>;
}

interface BlueskyRuntimeController {
  getStatus(): Promise<PublicBlueskyChannelStatus>;
  createRegistration(): ReturnType<BlueskyChannelController['createRegistration']>;
}

interface DevRuntimeController {
  getStatus(): Promise<PublicDevChannelStatus>;
  createRegistration(project: {
    canonicalOrigins: readonly string[];
    tags: readonly string[];
  }): ReturnType<DevChannelController['createRegistration']>;
  createEnabledClient(): Promise<DevObservabilityClient | null>;
}

interface MastodonRuntimeController {
  getStatus(): Promise<PublicMastodonChannelStatus>;
  createRegistration(): ReturnType<MastodonChannelController['createRegistration']>;
  createEnabledClient(): Promise<MastodonObservabilityClient | null>;
}

interface LocalRuntimeOptions {
  projects: Pick<ProjectProfileStore, 'require'>;
  github: (project: ProjectProfile) => GitHubRuntimeController;
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
      const project = await options.projects.require(request.projectId);
      assertProjectPublishRequest(project, request);
      const channels = new Set(request.packages.map((packageValue) => packageValue.channel));
      const registrations = [];
      if (channels.has('github')) {
        registrations.push(await options.github(project).createRegistration());
      }
      if (channels.has('bluesky') && options.bluesky) {
        registrations.push(await options.bluesky.createRegistration());
      }
      if (channels.has('dev') && options.dev) {
        if (!project.dev) {
          throw new MarketingOpsError('INVALID_INPUT', 'DEV project policy is not configured');
        }
        registrations.push(
          await options.dev.createRegistration({
            canonicalOrigins: project.canonicalOrigins,
            tags: project.dev.tags,
          }),
        );
      }
      if (channels.has('mastodon') && options.mastodon) {
        registrations.push(await options.mastodon.createRegistration());
      }
      return new PublishService({
        profile: project,
        registrations: registrations.filter((registration) => registration !== null),
        receipts: options.receipts,
      }).publish(request);
    },
  });

  return async (name, input) => {
    if (name === 'publish_campaign') {
      return publishHandler(name, input);
    }
    try {
      assertSafeToolInput(input);
      if (name === 'channels_status') {
        const request = TOOL_INPUT_SCHEMAS.channels_status.parse(input);
        const project = await options.projects.require(request.projectId);
        let github: PublicGitHubChannelStatus;
        let weibo: PublicWeiboChannelStatus | null = null;
        let bluesky: PublicBlueskyChannelStatus | null = null;
        let dev: PublicDevChannelStatus | null = null;
        let mastodon: PublicMastodonChannelStatus | null = null;
        if (project.channels.includes('github')) {
          try {
            github = await options.github(project).getStatus();
          } catch {
            github = blockedGitHubStatus();
          }
        } else {
          github = projectDisabledStatus('github') as PublicGitHubChannelStatus;
        }
        if (options.weibo && project.channels.includes('weibo')) {
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
        if (options.bluesky && project.channels.includes('bluesky')) {
          try {
            bluesky = await options.bluesky.getStatus();
          } catch {
            bluesky = blockedBlueskyStatus();
          }
        }
        if (options.dev && project.channels.includes('dev')) {
          try {
            dev = await options.dev.getStatus();
          } catch {
            dev = blockedDevStatus();
          }
        }
        if (options.mastodon && project.channels.includes('mastodon')) {
          try {
            mastodon = await options.mastodon.getStatus();
          } catch {
            mastodon = blockedMastodonStatus();
          }
        }
        const channels = defaultChannelStatuses().map((status) => {
          if (status.channel === 'github') return github;
          if (!project.channels.includes(status.channel as never)) {
            return projectDisabledStatus(status.channel);
          }
          if (status.channel === 'weibo' && weibo) return weibo;
          if (status.channel === 'bluesky' && bluesky) return bluesky;
          if (status.channel === 'dev' && dev) return dev;
          if (status.channel === 'mastodon' && mastodon) return mastodon;
          return status;
        });
        return {
          data: { contractVersion: CONTRACT_VERSION, projectId: project.id, channels },
        };
      }
      if (name === 'get_publish_status') {
        const request = TOOL_INPUT_SCHEMAS.get_publish_status.parse(input);
        const project = await options.projects.require(request.projectId);
        const receipts = await options.receipts.listByCampaign(project.id, request.campaignId);
        const status =
          receipts.length === 0
            ? 'not-found'
            : receipts.some((receipt) => receipt.status === 'queued')
              ? 'in-progress'
              : 'complete';
        return {
          data: {
            projectId: project.id,
            campaignId: request.campaignId,
            status,
            receipts,
            failures: [],
          },
        };
      }
      if (name === 'list_feedback') {
        const request = TOOL_INPUT_SCHEMAS.list_feedback.parse(input);
        const project = await options.projects.require(request.projectId);
        if (
          request.postRef.channel !== 'github' &&
          request.postRef.channel !== 'dev' &&
          request.postRef.channel !== 'mastodon'
        ) {
          return unavailableOperation();
        }
        const postRef = request.postRef;
        const receipt = await options.receipts.findKnownPostRef(project.id, postRef);
        if (!receipt) {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post receipt was not found');
        }
        if (receipt.status !== 'published') {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post is not published');
        }
        if (postRef.channel === 'github') {
          const collector = await enabledCollector(options.github(project), project);
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
        const project = await options.projects.require(request.projectId);
        const receipts = (
          await options.receipts.listByCampaign(project.id, request.campaignId)
        ).filter(
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
              projectId: project.id,
              window: request.window,
              status: 'unavailable',
              reason: 'No published observable receipt was found',
            },
          };
        }
        const channels = [];
        for (const receipt of receipts) {
          if (receipt.channel === 'github') {
            channels.push(
              await (await enabledCollector(options.github(project), project)).collect(receipt),
            );
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
            projectId: project.id,
            window: request.window,
            status: 'available',
            channels,
          },
        };
      }
      if (name === 'delete_post') {
        const request = TOOL_INPUT_SCHEMAS.delete_post.parse(input);
        const project = await options.projects.require(request.projectId);
        const receipt = await options.receipts.findByPostRef(
          project.id,
          request.campaignId,
          request.postRef,
        );
        if (!receipt) {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post receipt was not found');
        }
        if (receipt.status === 'deleted') {
          return {
            data: {
              projectId: project.id,
              campaignId: request.campaignId,
              status: 'already-deleted',
            },
          };
        }
        if (receipt.status !== 'published') {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post is not published');
        }
        const registration =
          receipt.channel === 'github'
            ? await options.github(project).createRegistration()
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
        await options.receipts.markDeleted(project.id, receipt.idempotencyKey);
        return {
          data: {
            projectId: project.id,
            campaignId: request.campaignId,
            status: result.status,
          },
        };
      }
      if (name === 'reply_feedback') {
        const request = TOOL_INPUT_SCHEMAS.reply_feedback.parse(input);
        const project = await options.projects.require(request.projectId);
        const receipt = await options.receipts.findByPostRef(
          project.id,
          request.campaignId,
          request.postRef,
        );
        if (!receipt) {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post receipt was not found');
        }
        return unavailableOperation();
      }
      return unavailableOperation();
    } catch (error) {
      return operationError(error);
    }
  };
}

function projectDisabledStatus(channel: string) {
  return {
    channel,
    alias: null,
    health: 'blocked' as const,
    adapterReady: false,
    nextAction: 'Enable the channel in the project profile',
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

async function enabledCollector(
  github: GitHubRuntimeController,
  project: ProjectProfile,
): Promise<GitHubCollector> {
  const client = await github.createEnabledClient();
  if (!client) {
    throw new MarketingOpsError('ADAPTER_UNAVAILABLE', 'GitHub adapter is not enabled and ready');
  }
  if (!project.github) {
    throw new MarketingOpsError('INVALID_INPUT', 'GitHub project policy is not configured');
  }
  return new GitHubCollector({ client, repository: project.github.repository });
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
  project: ProjectProfile,
  root: string = marketingOpsDataRoot(),
): GitHubChannelController {
  if (!project.github) {
    throw new MarketingOpsError('INVALID_INPUT', 'GitHub project policy is not configured');
  }
  const client = new GitHubCliClient();
  return new GitHubChannelController({
    client,
    activations: new GitHubActivationStore(root, project.id, project.github.repository),
    repository: project.github.repository,
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
  const projects = new ProjectProfileStore(root);
  return createLocalRuntimeToolHandler({
    projects,
    github: (project) => createDefaultGitHubController(project, root),
    weibo: createDefaultWeiboController(),
    bluesky: createDefaultBlueskyController(root),
    dev: createDefaultDevController(root),
    mastodon: createDefaultMastodonController(root),
    receipts: new ReceiptStore(root),
  });
}
