import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubActivationStore } from './activation-store.js';
import { BlueskyActivationStore } from './bluesky-activation-store.js';
import { DevActivationStore } from './dev-activation-store.js';
import { BlueskyChannelController, type PublicBlueskyChannelStatus } from './bluesky-channel.js';
import { AdapterError } from './adapters/contract.js';
import { GitHubIssueAdapter, type GitHubIssueClient } from './adapters/github-issue.js';
import {
  GitHubIssueReplyAdapter,
  type GitHubIssueReplyClient,
} from './adapters/github-issue-reply.js';
import { BlueskyApiClient, type BlueskyCredentials } from './adapters/bluesky-api.js';
import { DevApiClient } from './adapters/dev-api.js';
import { MastodonApiClient, type MastodonCredentials } from './adapters/mastodon-api.js';
import { GitHubCliClient } from './adapters/github-cli.js';
import { WeiboCliClient } from './adapters/weibo-cli.js';
import { DevChannelController, type PublicDevChannelStatus } from './dev-channel.js';
import { DevCollector, type DevObservabilityClient } from './dev-observability.js';
import { CampaignPolicyStore } from './campaign-policy-store.js';
import { buildStandardCampaignReport, type CollectorOutcome } from './campaign-report.js';
import { buildBugIssue, buildFaqReply, classifyFeedback } from './feedback-policy.js';
import {
  buildFollowUpSchedule,
  isPrimaryPublicationReceipt,
  reportWindowState,
} from './follow-up-schedule.js';
import { GitHubChannelController, type PublicGitHubChannelStatus } from './github-channel.js';
import { MastodonChannelController, type PublicMastodonChannelStatus } from './mastodon-channel.js';
import { MastodonCollector, type MastodonObservabilityClient } from './mastodon-observability.js';
import { MastodonActivationStore } from './mastodon-activation-store.js';
import { assertSafeToolInput, CONTRACT_VERSION, TOOL_INPUT_SCHEMAS } from './contract.js';
import { MarketingOpsError } from './errors.js';
import { GitHubCollector, type GitHubObservabilityClient } from './github-observability.js';
import { PublishService, type ReceiptRepository } from './publish-service.js';
import {
  ReceiptStore,
  receiptProjectId,
  type PublicPostRef,
  type PublishReceipt,
} from './receipt-store.js';
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
  createEnabledIssueClient?(): Promise<(GitHubIssueClient & GitHubIssueReplyClient) | null>;
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
  campaignPolicies?: Pick<CampaignPolicyStore, 'save' | 'get'>;
  now?: () => string;
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
      await options.campaignPolicies?.save({
        schemaVersion: 1,
        projectId: request.projectId,
        campaignId: request.campaignId,
        replies: request.spec.replies,
      });
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
      const result = await new PublishService({
        profile: project,
        registrations: registrations.filter((registration) => registration !== null),
        receipts: options.receipts,
      }).publish(request);
      const receipts = await options.receipts.listByCampaign(project.id, request.campaignId);
      return {
        ...result,
        followUps: buildFollowUpSchedule({
          projectId: project.id,
          campaignId: request.campaignId,
          receipts,
        }),
      };
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
            followUps: buildFollowUpSchedule({
              projectId: project.id,
              campaignId: request.campaignId,
              receipts,
            }),
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
        const receipts = await options.receipts.listByCampaign(project.id, request.campaignId);
        const followUp = buildFollowUpSchedule({
          projectId: project.id,
          campaignId: request.campaignId,
          receipts,
        }).find((task) => task.window === request.window);
        if (!followUp) {
          return {
            data: {
              campaignId: request.campaignId,
              projectId: project.id,
              window: request.window,
              status: 'unavailable',
              reason: 'No successful primary publication receipt was found',
            },
          };
        }
        const generatedAt = (options.now ?? (() => new Date().toISOString()))();
        if (reportWindowState(followUp, generatedAt) === 'scheduled') {
          return {
            data: {
              schemaVersion: 1,
              campaignId: request.campaignId,
              projectId: project.id,
              window: request.window,
              status: 'scheduled',
              anchorAt: followUp.anchorAt,
              dueAt: followUp.dueAt,
              generatedAt,
              channels: [],
              artifacts: reportArtifacts(receipts),
              limitations: ['collector-not-called-before-window-is-due'],
            },
          };
        }
        const outcomes: Record<string, CollectorOutcome> = {};
        for (const receipt of receipts.filter(isPrimaryPublicationReceipt)) {
          outcomes[receipt.idempotencyKey] = await collectReceiptOutcome(receipt, project, options);
        }
        return {
          data: buildStandardCampaignReport({
            projectId: project.id,
            campaignId: request.campaignId,
            window: request.window,
            followUp,
            generatedAt,
            receipts,
            outcomes,
          }),
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
        if (receipt.status !== 'published') {
          throw new MarketingOpsError('INVALID_INPUT', 'Known post is not published');
        }
        const policy = await options.campaignPolicies?.get(project.id, request.campaignId);
        if (!policy || policy.replies.mode !== 'faq-only') {
          throw new MarketingOpsError(
            'ADAPTER_UNAVAILABLE',
            'Campaign FAQ policy is not available',
          );
        }
        const feedback = await findFeedback(options, project, request.postRef, request.commentId);
        const decision = classifyFeedback({
          id: feedback.id,
          channel: request.postRef.channel,
          body: feedback.body,
          sourceUrl: feedback.sourceUrl,
        });
        if (request.action === 'bug-issue') {
          if (!policy.replies.createBugIssues || decision.decision !== 'bug') {
            throw new MarketingOpsError(
              'ADAPTER_UNAVAILABLE',
              'Feedback is not eligible for automatic Bug Issue routing',
            );
          }
          const issueClient = await enabledIssueClient(options.github(project));
          const operationKey = feedbackOperationKey(request, 'bug-issue');
          const existing = await knownFeedbackArtifact(
            options.receipts,
            project.id,
            request.campaignId,
            operationKey,
            'github-issue@',
          );
          if (existing) {
            return {
              data: { action: 'bug-issue', receipt: existing, reused: true },
            };
          }
          const result = await new GitHubIssueAdapter({
            client: issueClient,
            repository: requireGitHubRepository(project),
          }).create(
            buildBugIssue({
              projectId: project.id,
              campaignId: request.campaignId,
              feedback: {
                id: feedback.id,
                channel: request.postRef.channel,
                body: feedback.body,
                sourceUrl: feedback.sourceUrl,
              },
              idempotencyKey: operationKey,
            }),
          );
          const stored = await saveFeedbackArtifact(options.receipts, result.receipt);
          return {
            data: {
              action: 'bug-issue',
              receipt: stored.receipt,
              reused: result.reused || stored.reused,
            },
          };
        }
        if (decision.decision !== 'faq') {
          throw new MarketingOpsError('ADAPTER_UNAVAILABLE', 'Feedback requires Owner review');
        }
        if (
          request.postRef.channel !== 'github' ||
          !request.postRef.publicUrl.includes('/issues/')
        ) {
          return unavailableOperation();
        }
        const body = buildFaqReply(decision, project.canonicalOrigins[0]!);
        if (request.body !== undefined && request.body !== body) {
          throw new MarketingOpsError(
            'INVALID_INPUT',
            'FAQ reply body does not match the approved template',
          );
        }
        const issueClient = await enabledIssueClient(options.github(project));
        const operationKey = feedbackOperationKey(request, 'faq-reply');
        const existing = await knownFeedbackArtifact(
          options.receipts,
          project.id,
          request.campaignId,
          operationKey,
          'github-issue-reply@',
        );
        if (existing) {
          return { data: { action: 'faq-reply', body, receipt: existing, reused: true } };
        }
        const issueNumber = Number(request.postRef.postId);
        const result = await new GitHubIssueReplyAdapter({
          client: issueClient,
          repository: requireGitHubRepository(project),
        }).reply({
          projectId: project.id,
          campaignId: request.campaignId,
          issueNumber,
          issueUrl: request.postRef.publicUrl,
          sourceCommentId: request.commentId,
          body,
          idempotencyKey: operationKey,
        });
        const stored = await saveFeedbackArtifact(options.receipts, result.receipt);
        return {
          data: {
            action: 'faq-reply',
            body,
            receipt: stored.receipt,
            reused: result.reused || stored.reused,
          },
        };
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

function reportArtifacts(receipts: readonly PublishReceipt[]) {
  return receipts
    .filter((receipt) => !isPrimaryPublicationReceipt(receipt))
    .map((receipt) => ({
      channel: receipt.channel,
      postId: receipt.postId,
      publicUrl: receipt.publicUrl,
      adapterVersion: receipt.adapterVersion,
      status: receipt.status,
    }));
}

async function collectReceiptOutcome(
  receipt: PublishReceipt,
  project: ProjectProfile,
  options: LocalRuntimeOptions,
): Promise<CollectorOutcome> {
  if (receipt.status !== 'published') {
    return { status: 'unavailable', reason: `post-${receipt.status}` };
  }
  try {
    if (receipt.channel === 'github') {
      const collector = await enabledCollector(options.github(project), project);
      return { status: 'available', observation: await collector.collect(receipt) };
    }
    if (receipt.channel === 'dev') {
      if (!options.dev) return { status: 'unavailable', reason: 'collector-not-configured' };
      const collector = await enabledDevCollector(options.dev);
      return { status: 'available', observation: await collector.collect(receipt) };
    }
    if (receipt.channel === 'mastodon') {
      if (!options.mastodon) {
        return { status: 'unavailable', reason: 'collector-not-configured' };
      }
      const collector = await enabledMastodonCollector(options.mastodon);
      return { status: 'available', observation: await collector.collect(receipt) };
    }
    return { status: 'unavailable', reason: 'collector-not-implemented' };
  } catch (error) {
    if (error instanceof AdapterError) {
      return { status: 'failed', code: error.code, retryable: error.retryable };
    }
    if (error instanceof MarketingOpsError) {
      const code =
        error.code === 'INVALID_INPUT' || error.code === 'STORAGE_CORRUPTED'
          ? error.code
          : error.code === 'REAUTH_REQUIRED'
            ? 'REAUTH_REQUIRED'
            : 'ADAPTER_UNAVAILABLE';
      return { status: 'failed', code, retryable: false };
    }
    return { status: 'failed', code: 'ADAPTER_UNAVAILABLE', retryable: false };
  }
}

interface RuntimeFeedbackItem {
  id: string;
  body: string;
  sourceUrl: string;
}

interface FeedbackPage {
  items: RuntimeFeedbackItem[];
  nextCursor: string | null;
}

async function findFeedback(
  options: LocalRuntimeOptions,
  project: ProjectProfile,
  postRef: PublicPostRef,
  commentId: string,
): Promise<RuntimeFeedbackItem> {
  let cursor: string | undefined;
  for (let page = 1; page <= 10; page += 1) {
    let result: FeedbackPage;
    if (postRef.channel === 'github') {
      result = (await enabledCollector(options.github(project), project).then((collector) =>
        collector.listFeedback(postRef, cursor),
      )) as FeedbackPage;
    } else if (postRef.channel === 'dev' && options.dev) {
      result = (await enabledDevCollector(options.dev).then((collector) =>
        collector.listFeedback(postRef, cursor),
      )) as FeedbackPage;
    } else if (postRef.channel === 'mastodon' && options.mastodon) {
      result = (await enabledMastodonCollector(options.mastodon).then((collector) =>
        collector.listFeedback(postRef),
      )) as FeedbackPage;
    } else {
      throw new MarketingOpsError(
        'ADAPTER_UNAVAILABLE',
        'Feedback collector is not enabled and ready',
      );
    }
    const feedback = result.items.find((item) => item.id === commentId);
    if (feedback) return feedback;
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  throw new MarketingOpsError('INVALID_INPUT', 'Known feedback item was not found');
}

async function enabledIssueClient(
  github: GitHubRuntimeController,
): Promise<GitHubIssueClient & GitHubIssueReplyClient> {
  const client = await github.createEnabledIssueClient?.();
  if (!client) {
    throw new MarketingOpsError(
      'ADAPTER_UNAVAILABLE',
      'GitHub Issue adapter is not enabled and ready',
    );
  }
  return client;
}

function feedbackOperationKey(
  request: {
    projectId: string;
    campaignId: string;
    idempotencyKey: string;
    commentId: string;
  },
  action: 'faq-reply' | 'bug-issue',
): string {
  const digest = createHash('sha256')
    .update(
      `${request.projectId}\0${request.campaignId}\0${request.idempotencyKey}\0${request.commentId}\0${action}`,
    )
    .digest('hex');
  return `feedback-v1/${request.projectId}/${request.campaignId}/${action}/${digest}`;
}

async function knownFeedbackArtifact(
  receipts: RuntimeReceiptRepository,
  projectId: string,
  campaignId: string,
  operationKey: string,
  adapterPrefix: string,
): Promise<PublishReceipt | null> {
  const receipt = await receipts.getByIdempotencyKey(operationKey);
  if (!receipt) return null;
  if (
    receiptProjectId(receipt) !== projectId ||
    receipt.campaignId !== campaignId ||
    receipt.idempotencyKey !== operationKey ||
    receipt.status !== 'published' ||
    !receipt.adapterVersion.startsWith(adapterPrefix)
  ) {
    throw new MarketingOpsError(
      'STORAGE_CORRUPTED',
      'Feedback artifact receipt conflicts with this operation',
    );
  }
  return receipt;
}

async function saveFeedbackArtifact(receipts: RuntimeReceiptRepository, receipt: PublishReceipt) {
  return receipts.save(receipt);
}

function requireGitHubRepository(project: ProjectProfile): string {
  if (!project.github) {
    throw new MarketingOpsError('INVALID_INPUT', 'GitHub project policy is not configured');
  }
  return project.github.repository;
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
    campaignPolicies: new CampaignPolicyStore(root),
  });
}
