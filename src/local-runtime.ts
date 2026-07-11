import { homedir } from 'node:os';
import { join } from 'node:path';
import { GitHubActivationStore } from './activation-store.js';
import { AdapterError } from './adapters/contract.js';
import { GitHubCliClient } from './adapters/github-cli.js';
import { WeiboCliClient } from './adapters/weibo-cli.js';
import { GitHubChannelController, type PublicGitHubChannelStatus } from './github-channel.js';
import { assertSafeToolInput, TOOL_INPUT_SCHEMAS } from './contract.js';
import { MarketingOpsError } from './errors.js';
import { GitHubCollector, type GitHubObservabilityClient } from './github-observability.js';
import { PublishService, type ReceiptRepository } from './publish-service.js';
import { ReceiptStore, type PublicPostRef, type PublishReceipt } from './receipt-store.js';
import { createRuntimeToolHandler } from './runtime-handler.js';
import { defaultChannelStatuses, type MarketingToolHandler } from './server-factory.js';
import { WeiboChannelController, type PublicWeiboChannelStatus } from './weibo-channel.js';

export const GITHUB_REPOSITORY = 'IllegalCreed/algorithms-visualization';

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

interface LocalRuntimeOptions {
  github: GitHubRuntimeController;
  weibo?: { getStatus(): Promise<PublicWeiboChannelStatus> };
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
    if (name === 'publish_campaign' || name === 'reply_feedback') {
      return publishHandler(name, input);
    }
    try {
      assertSafeToolInput(input);
      if (name === 'channels_status') {
        TOOL_INPUT_SCHEMAS.channels_status.parse(input);
        let github: PublicGitHubChannelStatus;
        let weibo: PublicWeiboChannelStatus | null = null;
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
        const channels = defaultChannelStatuses().map((status) => {
          if (status.channel === 'github') return github;
          if (status.channel === 'weibo' && weibo) return weibo;
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
        if (request.postRef.channel !== 'github') return unavailableOperation();
        const postRef = { ...request.postRef, channel: 'github' as const };
        const receipt = await options.receipts.findKnownPostRef(postRef);
        if (!receipt) {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post receipt was not found');
        }
        if (receipt.status !== 'published') {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post is not published');
        }
        const collector = await enabledCollector(options.github);
        return { data: await collector.listFeedback(postRef, request.cursor) };
      }
      if (name === 'get_campaign_report') {
        const request = TOOL_INPUT_SCHEMAS.get_campaign_report.parse(input);
        const receipts = (await options.receipts.listByCampaign(request.campaignId)).filter(
          (receipt) =>
            receipt.channel === 'github' &&
            receipt.status === 'published' &&
            receipt.publicUrl.includes('/releases/'),
        );
        if (receipts.length === 0) {
          return {
            data: {
              campaignId: request.campaignId,
              window: request.window,
              status: 'unavailable',
              reason: 'No published GitHub Release receipt was found',
            },
          };
        }
        const collector = await enabledCollector(options.github);
        const channels = [];
        for (const receipt of receipts) channels.push(await collector.collect(receipt));
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
        if (receipt.channel !== 'github') return unavailableOperation();
        if (receipt.status !== 'published') {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post is not published');
        }
        const registration = await options.github.createRegistration();
        if (!registration?.adapter.delete) return unavailableOperation();
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

export function createDefaultLocalRuntimeToolHandler(
  root: string = marketingOpsDataRoot(),
): MarketingToolHandler {
  return createLocalRuntimeToolHandler({
    github: createDefaultGitHubController(root),
    weibo: createDefaultWeiboController(),
    receipts: new ReceiptStore(root),
  });
}
