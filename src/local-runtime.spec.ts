import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from './adapters/contract.js';
import {
  createDefaultBlueskyClient,
  createDefaultDevClient,
  createDefaultGitHubController,
  createLocalRuntimeToolHandler,
  createDefaultMastodonClient,
  marketingOpsDataRoot,
} from './local-runtime.js';
import type { AdapterRegistration, ReceiptRepository } from './publish-service.js';
import type { PublishReceipt } from './receipt-store.js';
import { receiptProjectId } from './receipt-store.js';
import type { ProjectProfile } from './project-profile-store.js';
import { ProjectProfileStore } from './project-profile-store.js';
import {
  createBlueskyPublishRequest,
  createDevPublishRequest,
  createMastodonPublishRequest,
  createPublishRequest,
} from './test-fixtures.js';

const PROJECT_ID = 'algorithm-visualizer';
const PROJECT_PROFILE: ProjectProfile = {
  schemaVersion: 1,
  id: PROJECT_ID,
  displayName: 'Algorithm Visualizer',
  canonicalOrigins: ['https://algo.illegalscreed.cn'],
  channels: ['github', 'weibo', 'bluesky', 'dev', 'mastodon'],
  github: { repository: 'IllegalCreed/algorithms-visualization' },
  dev: { tags: ['algorithms', 'webdev', 'opensource'] },
};

function projects(profile: ProjectProfile = PROJECT_PROFILE) {
  return {
    require: vi.fn(async (projectId: string) => {
      if (projectId !== profile.id) throw new Error('unknown project');
      return profile;
    }),
  };
}

class MemoryReceipts implements ReceiptRepository {
  readonly values = new Map<string, PublishReceipt>();

  async getByIdempotencyKey(key: string) {
    return this.values.get(key) ?? null;
  }

  async save(receipt: PublishReceipt) {
    this.values.set(receipt.idempotencyKey, receipt);
    return { receipt, reused: false };
  }

  async listByCampaign(projectId: string, campaignId: string) {
    return [...this.values.values()].filter(
      (receipt) => receiptProjectId(receipt) === projectId && receipt.campaignId === campaignId,
    );
  }

  async findKnownPostRef(
    projectId: string,
    postRef: { channel: string; postId: string; publicUrl: string },
  ) {
    return (
      [...this.values.values()].find(
        (receipt) =>
          receiptProjectId(receipt) === projectId &&
          receipt.channel === postRef.channel &&
          receipt.postId === postRef.postId &&
          receipt.publicUrl === postRef.publicUrl,
      ) ?? null
    );
  }

  async findByPostRef(
    projectId: string,
    campaignId: string,
    postRef: { channel: string; postId: string; publicUrl: string },
  ) {
    const receipt = await this.findKnownPostRef(projectId, postRef);
    return receipt?.campaignId === campaignId ? receipt : null;
  }

  async markDeleted(projectId: string, key: string) {
    const receipt = this.values.get(key);
    if (!receipt || receiptProjectId(receipt) !== projectId) throw new Error('not found');
    const deleted = { ...receipt, status: 'deleted' as const };
    this.values.set(key, deleted);
    return deleted;
  }
}

function adapter() {
  const value: ChannelAdapter = {
    definition: {
      channel: 'github',
      version: 'github-test@1.0.0',
      capabilities: {
        publish: true,
        status: true,
        metrics: false,
        feedback: false,
        reply: false,
        delete: false,
      },
    },
    expectedFormat: 'release',
    preflight: vi.fn(async () => undefined),
    publish: vi.fn<ChannelAdapter['publish']>(async (input) => ({
      reused: false,
      receipt: {
        schemaVersion: 2 as const,
        projectId: input.projectId,
        campaignId: input.campaignId,
        channel: 'github' as const,
        postId: '123',
        publicUrl:
          'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Fquick-sort-launch',
        publishedAt: '2026-07-11T00:00:00.000Z',
        contentHash: input.contentHash,
        idempotencyKey: input.idempotencyKey,
        adapterVersion: 'github-test@1.0.0',
        status: 'published' as const,
      },
    })),
  };
  return value;
}

function blueskyAdapter() {
  const value: ChannelAdapter = {
    definition: {
      channel: 'bluesky',
      version: 'bluesky-test@1.0.0',
      capabilities: {
        publish: true,
        status: false,
        metrics: false,
        feedback: false,
        reply: false,
        delete: true,
      },
    },
    expectedFormat: 'post',
    preflight: vi.fn(async () => undefined),
    publish: vi.fn<ChannelAdapter['publish']>(async (input) => ({
      reused: false,
      receipt: {
        schemaVersion: 2 as const,
        projectId: input.projectId,
        campaignId: input.campaignId,
        channel: 'bluesky' as const,
        postId: 'at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3ltx4abcde22a',
        publicUrl: 'https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/post/3ltx4abcde22a',
        publishedAt: '2026-07-14T10:00:00.000Z',
        contentHash: input.contentHash,
        idempotencyKey: input.idempotencyKey,
        adapterVersion: 'bluesky-test@1.0.0',
        status: 'published' as const,
      },
    })),
    delete: vi.fn(async () => ({ status: 'deleted' as const })),
  };
  return value;
}

function mastodonAdapter() {
  const value: ChannelAdapter = {
    definition: {
      channel: 'mastodon',
      version: 'mastodon-test@1.0.0',
      capabilities: {
        publish: true,
        status: true,
        metrics: true,
        feedback: true,
        reply: false,
        delete: true,
      },
    },
    expectedFormat: 'status',
    preflight: vi.fn(async () => undefined),
    publish: vi.fn<ChannelAdapter['publish']>(async (input) => ({
      reused: false,
      receipt: {
        schemaVersion: 2 as const,
        projectId: input.projectId,
        campaignId: input.campaignId,
        channel: 'mastodon' as const,
        postId: '201',
        publicUrl: 'https://mastodon.social/@illegalcreed/201',
        publishedAt: '2026-07-16T01:00:00.000Z',
        contentHash: input.contentHash,
        idempotencyKey: input.idempotencyKey,
        adapterVersion: 'mastodon-test@1.0.0',
        status: 'published' as const,
      },
    })),
    delete: vi.fn(async () => ({ status: 'deleted' as const })),
  };
  return value;
}

describe('local runtime lazy GitHub wiring', () => {
  it('TC-AUTO-RUNTIME-127-01 status 动态但 publish 仅在 activation+health ready 时注入', async () => {
    const githubAdapter = adapter();
    const github = {
      getStatus: vi.fn(async () => ({
        channel: 'github' as const,
        alias: 'IllegalCreed',
        health: 'ready' as const,
        adapterReady: false,
        nextAction: 'Run marketing-ops setup github',
      })),
      createRegistration: vi.fn(async (): Promise<AdapterRegistration | null> => null),
      createEnabledClient: vi.fn(async () => null),
    };
    const handler = createLocalRuntimeToolHandler({
      projects: projects(),
      github: () => github,
      weibo: {
        getStatus: vi.fn(async () => ({
          channel: 'weibo' as const,
          alias: null,
          health: 'not-configured' as const,
          adapterReady: false as const,
          nextAction: 'Install official @weibo-ai/weibo-cli',
        })),
      },
      bluesky: {
        getStatus: vi.fn(async () => ({
          channel: 'bluesky' as const,
          alias: 'algorithms-visualization.bsky.social',
          health: 'ready' as const,
          adapterReady: false,
          nextAction: 'Run marketing-ops setup bluesky',
        })),
        createRegistration: vi.fn(async () => null),
      },
      mastodon: {
        getStatus: vi.fn(async () => ({
          channel: 'mastodon' as const,
          alias: 'illegalcreed@mastodon.social',
          health: 'ready' as const,
          adapterReady: false,
          nextAction: 'Run marketing-ops setup mastodon',
        })),
        createRegistration: vi.fn(async () => null),
        createEnabledClient: vi.fn(async () => null),
      },
      receipts: new MemoryReceipts(),
    });

    const status = await handler('channels_status', { projectId: PROJECT_ID });
    const data = status.data as {
      contractVersion: number;
      channels: Array<Record<string, unknown>>;
    };
    expect(data.contractVersion).toBe(3);
    expect(data.channels).toHaveLength(5);
    expect(data.channels.find((channel) => channel.channel === 'github')).toMatchObject({
      alias: 'IllegalCreed',
      health: 'ready',
      adapterReady: false,
    });
    expect(data.channels.find((channel) => channel.channel === 'weibo')).toMatchObject({
      health: 'not-configured',
      adapterReady: false,
      nextAction: 'Install official @weibo-ai/weibo-cli',
    });
    expect(data.channels.find((channel) => channel.channel === 'bluesky')).toMatchObject({
      alias: 'algorithms-visualization.bsky.social',
      health: 'ready',
      adapterReady: false,
    });
    await expect(handler('publish_campaign', createPublishRequest())).resolves.toMatchObject({
      isError: true,
      data: { receipts: [], failures: [{ code: 'ADAPTER_UNAVAILABLE' }] },
    });
    expect(githubAdapter.publish).not.toHaveBeenCalled();

    github.createRegistration.mockResolvedValueOnce({
      adapter: githubAdapter,
      enabled: true,
      health: 'ready',
    });
    await expect(handler('publish_campaign', createPublishRequest())).resolves.toMatchObject({
      data: { receipts: [{ channel: 'github', postId: '123' }], failures: [] },
    });
    expect(github.createRegistration).toHaveBeenCalledTimes(2);
    expect(githubAdapter.publish).toHaveBeenCalledOnce();
  });

  it('TC-AUTO-BSKYRUNTIME-127-01 只为请求中的 Bluesky 惰性注册 adapter', async () => {
    const adapter = blueskyAdapter();
    const github = {
      getStatus: vi.fn(),
      createRegistration: vi.fn(async () => null),
      createEnabledClient: vi.fn(async () => null),
    };
    const bluesky = {
      getStatus: vi.fn(async () => ({
        channel: 'bluesky' as const,
        alias: 'algorithms-visualization.bsky.social',
        health: 'ready' as const,
        adapterReady: true,
        nextAction: null,
      })),
      createRegistration: vi.fn(async (): Promise<AdapterRegistration> => ({
        adapter,
        enabled: true,
        health: 'ready',
      })),
    };
    const handler = createLocalRuntimeToolHandler({
      projects: projects(),
      github: () => github,
      bluesky,
      receipts: new MemoryReceipts(),
    });

    await expect(handler('publish_campaign', createBlueskyPublishRequest())).resolves.toMatchObject(
      {
        data: {
          receipts: [{ channel: 'bluesky', postId: expect.stringMatching(/^at:\/\//) }],
          failures: [],
        },
      },
    );
    expect(bluesky.createRegistration).toHaveBeenCalledOnce();
    expect(github.createRegistration).not.toHaveBeenCalled();
    expect(adapter.publish).toHaveBeenCalledOnce();

    await expect(handler('publish_campaign', createPublishRequest())).resolves.toMatchObject({
      isError: true,
      data: { failures: [{ channel: 'github', code: 'ADAPTER_UNAVAILABLE' }] },
    });
    expect(bluesky.createRegistration).toHaveBeenCalledOnce();
    expect(github.createRegistration).toHaveBeenCalledOnce();
  });

  it('TC-AUTO-BSKYRUNTIME-127-02 Bluesky 删除只走已知 receipt 与动态 registration', async () => {
    const adapter = blueskyAdapter();
    const receipts = new MemoryReceipts();
    const bluesky = {
      getStatus: vi.fn(),
      createRegistration: vi.fn(async (): Promise<AdapterRegistration> => ({
        adapter,
        enabled: true,
        health: 'ready',
      })),
    };
    const handler = createLocalRuntimeToolHandler({
      projects: projects(),
      github: () => ({
        getStatus: vi.fn(),
        createRegistration: vi.fn(async () => null),
        createEnabledClient: vi.fn(async () => null),
      }),
      bluesky,
      receipts,
    });
    const published = await handler('publish_campaign', createBlueskyPublishRequest());
    const receipt = (published.data as { receipts: PublishReceipt[] }).receipts[0]!;

    await expect(
      handler('delete_post', {
        projectId: PROJECT_ID,
        campaignId: receipt.campaignId,
        postRef: {
          channel: receipt.channel,
          postId: receipt.postId,
          publicUrl: receipt.publicUrl,
        },
        idempotencyKey: 'delete/quick-sort-launch/bluesky-0001',
        authorization: {
          source: 'owner-prompt',
          authorizedAt: '2026-07-14T12:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ data: { status: 'deleted' } });
    expect(adapter.delete).toHaveBeenCalledWith(receipt);
    expect((await receipts.listByCampaign(PROJECT_ID, receipt.campaignId))[0]).toMatchObject({
      status: 'deleted',
    });
    expect(bluesky.createRegistration).toHaveBeenCalledTimes(2);
  });

  it('TC-AUTO-MASTORUNTIME-127-01 只为请求中的 Mastodon 惰性注册 adapter', async () => {
    const adapter = mastodonAdapter();
    const github = {
      getStatus: vi.fn(),
      createRegistration: vi.fn(async () => null),
      createEnabledClient: vi.fn(async () => null),
    };
    const mastodon = {
      getStatus: vi.fn(async () => ({
        channel: 'mastodon' as const,
        alias: 'illegalcreed@mastodon.social',
        health: 'ready' as const,
        adapterReady: true,
        nextAction: null,
      })),
      createRegistration: vi.fn(async (): Promise<AdapterRegistration> => ({
        adapter,
        enabled: true,
        health: 'ready',
      })),
      createEnabledClient: vi.fn(async () => ({
        getStatus: vi.fn(async () => ({
          id: '201',
          uri: 'https://mastodon.social/users/illegalcreed/statuses/201',
          text: 'Quick Sort visualization is live',
          publicUrl: 'https://mastodon.social/@illegalcreed/201',
          publishedAt: '2026-07-16T01:00:00.000Z',
          replyCount: 0,
          reblogCount: 0,
          favouriteCount: 0,
        })),
        listNotifications: vi.fn(async () => []),
      })),
    };
    const receipts = new MemoryReceipts();
    const handler = createLocalRuntimeToolHandler({
      projects: projects(),
      github: () => github,
      mastodon,
      receipts,
    });

    const published = await handler('publish_campaign', createMastodonPublishRequest());
    expect(published).toMatchObject({
      data: {
        receipts: [{ channel: 'mastodon', postId: '201' }],
        failures: [],
      },
    });
    const publishedReceipt = (published.data as { receipts: PublishReceipt[] }).receipts[0]!;
    const postRef = {
      channel: publishedReceipt.channel,
      postId: publishedReceipt.postId,
      publicUrl: publishedReceipt.publicUrl,
    };
    expect(mastodon.createRegistration).toHaveBeenCalledOnce();
    expect(github.createRegistration).not.toHaveBeenCalled();
    expect(adapter.publish).toHaveBeenCalledOnce();

    const withoutMastodon = createLocalRuntimeToolHandler({
      projects: projects(),
      github: () => github,
      receipts,
    });
    await expect(
      withoutMastodon('list_feedback', { projectId: PROJECT_ID, postRef }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
    await expect(
      withoutMastodon('get_campaign_report', {
        projectId: PROJECT_ID,
        campaignId: publishedReceipt.campaignId,
        window: '1h',
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
    await expect(
      withoutMastodon('delete_post', {
        projectId: PROJECT_ID,
        campaignId: publishedReceipt.campaignId,
        postRef,
        idempotencyKey: 'delete/quick-sort-launch/mastodon-missing',
        authorization: {
          source: 'owner-prompt',
          authorizedAt: '2026-07-16T02:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });

    const unavailableMastodon = {
      ...mastodon,
      createEnabledClient: vi.fn(async () => null),
    };
    const unavailableHandler = createLocalRuntimeToolHandler({
      projects: projects(),
      github: () => github,
      mastodon: unavailableMastodon,
      receipts,
    });
    await expect(
      unavailableHandler('list_feedback', { projectId: PROJECT_ID, postRef }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });

    await expect(
      handler('list_feedback', { projectId: PROJECT_ID, postRef }),
    ).resolves.toMatchObject({ data: { items: [], nextCursor: null } });
    await expect(
      handler('get_campaign_report', {
        projectId: PROJECT_ID,
        campaignId: publishedReceipt.campaignId,
        window: '1h',
      }),
    ).resolves.toMatchObject({
      data: {
        status: 'available',
        channels: [expect.objectContaining({ channel: 'mastodon' })],
      },
    });
    await expect(
      handler('delete_post', {
        projectId: PROJECT_ID,
        campaignId: publishedReceipt.campaignId,
        postRef,
        idempotencyKey: 'delete/quick-sort-launch/mastodon-0001',
        authorization: {
          source: 'owner-prompt',
          authorizedAt: '2026-07-16T02:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ data: { status: 'deleted' } });
    expect(adapter.delete).toHaveBeenCalledWith(publishedReceipt);
  });

  it('TC-AUTO-ISOLATION-133-02 缺失项目策略与跨项目 operation 在 adapter 前失败关闭', async () => {
    const github = {
      getStatus: vi.fn(),
      createRegistration: vi.fn(async () => null),
      createEnabledClient: vi.fn(async () => ({}) as never),
    };
    const malformedDevProfile: ProjectProfile = {
      schemaVersion: 1,
      id: PROJECT_ID,
      displayName: 'Malformed DEV profile',
      canonicalOrigins: ['https://algo.illegalscreed.cn'],
      channels: ['dev'],
    };
    const dev = {
      getStatus: vi.fn(),
      createRegistration: vi.fn(async () => null),
      createEnabledClient: vi.fn(async () => null),
    };
    const malformedDev = createLocalRuntimeToolHandler({
      projects: projects(malformedDevProfile),
      github: () => github,
      dev,
      receipts: new MemoryReceipts(),
    });
    await expect(
      malformedDev('publish_campaign', createDevPublishRequest()),
    ).resolves.toMatchObject({ isError: true, data: { code: 'INVALID_INPUT' } });
    expect(dev.createRegistration).not.toHaveBeenCalled();

    const noGitHubProfile: ProjectProfile = {
      schemaVersion: 1,
      id: PROJECT_ID,
      displayName: 'No GitHub profile',
      canonicalOrigins: ['https://algo.illegalscreed.cn'],
      channels: ['bluesky'],
    };
    const githubFactory = vi.fn(() => github);
    const noGitHub = createLocalRuntimeToolHandler({
      projects: projects(noGitHubProfile),
      github: githubFactory,
      bluesky: {
        getStatus: vi.fn(async () => ({
          channel: 'bluesky' as const,
          alias: 'owner.bsky.social',
          health: 'ready' as const,
          adapterReady: true,
          nextAction: null,
        })),
        createRegistration: vi.fn(async () => null),
      },
      receipts: new MemoryReceipts(),
    });
    await expect(noGitHub('channels_status', { projectId: PROJECT_ID })).resolves.toMatchObject({
      data: {
        channels: expect.arrayContaining([
          expect.objectContaining({ channel: 'github', adapterReady: false }),
        ]),
      },
    });
    expect(githubFactory).not.toHaveBeenCalled();

    const malformedGitHubProfile: ProjectProfile = {
      ...noGitHubProfile,
      displayName: 'Malformed GitHub profile',
      channels: ['github'],
    };
    const knownReceipts = new MemoryReceipts();
    const knownReceipt: PublishReceipt = {
      schemaVersion: 2,
      projectId: PROJECT_ID,
      campaignId: 'quick-sort-launch',
      channel: 'github',
      postId: '123',
      publicUrl: 'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/example',
      publishedAt: '2026-07-11T00:00:00.000Z',
      contentHash: 'a'.repeat(64),
      idempotencyKey: 'campaign-v3/algorithm-visualizer/quick-sort-launch/github/example',
      adapterVersion: 'github-test@1.0.0',
      status: 'published',
    };
    knownReceipts.values.set(knownReceipt.idempotencyKey, knownReceipt);
    const malformedGitHub = createLocalRuntimeToolHandler({
      projects: projects(malformedGitHubProfile),
      github: () => github,
      receipts: knownReceipts,
    });
    const postRef = {
      channel: knownReceipt.channel,
      postId: knownReceipt.postId,
      publicUrl: knownReceipt.publicUrl,
    };
    await expect(
      malformedGitHub('list_feedback', { projectId: PROJECT_ID, postRef }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'INVALID_INPUT' } });

    await expect(
      malformedGitHub('reply_feedback', {
        projectId: PROJECT_ID,
        campaignId: 'missing-campaign',
        postRef,
        commentId: 'comment-1',
        body: 'Thanks.',
        policy: 'faq-only',
        idempotencyKey: 'reply/missing-campaign/example',
        authorization: {
          source: 'owner-prompt',
          authorizedAt: '2026-07-11T00:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'INVALID_INPUT' } });
  });

  it('TC-AUTO-RUNTIME-127-01 status 异常与默认工厂保持惰性失败关闭', async () => {
    const handler = createLocalRuntimeToolHandler({
      projects: projects(),
      github: () => ({
        getStatus: vi.fn().mockRejectedValue(new Error('Bearer private-token')),
        createRegistration: vi.fn(async () => null),
        createEnabledClient: vi.fn(async () => null),
      }),
      weibo: {
        getStatus: vi.fn().mockRejectedValue(new Error('cookie private-cookie')),
      },
      bluesky: {
        getStatus: vi.fn().mockRejectedValue(new Error('app-password private-secret')),
        createRegistration: vi.fn(async () => null),
      },
      mastodon: {
        getStatus: vi.fn().mockRejectedValue(new Error('access-token private-secret')),
        createRegistration: vi.fn(async () => null),
        createEnabledClient: vi.fn(async () => null),
      },
      receipts: new MemoryReceipts(),
    });
    const status = await handler('channels_status', { projectId: PROJECT_ID });
    const channels = (status.data as { channels: Array<Record<string, unknown>> }).channels;
    expect(channels.find((channel) => channel.channel === 'github')).toMatchObject({
      health: 'blocked',
      adapterReady: false,
    });
    expect(channels.find((channel) => channel.channel === 'weibo')).toMatchObject({
      health: 'blocked',
      adapterReady: false,
      nextAction: 'Run marketing-ops doctor',
    });
    expect(channels.find((channel) => channel.channel === 'bluesky')).toMatchObject({
      health: 'blocked',
      adapterReady: false,
      nextAction: 'Run marketing-ops doctor',
    });
    expect(channels.find((channel) => channel.channel === 'mastodon')).toMatchObject({
      health: 'blocked',
      adapterReady: false,
      nextAction: 'Run marketing-ops doctor',
    });
    expect(JSON.stringify(status)).not.toContain('private-token');
    expect(JSON.stringify(status)).not.toContain('private-cookie');
    expect(JSON.stringify(status)).not.toContain('private-secret');

    const withoutWeibo = createLocalRuntimeToolHandler({
      projects: projects(),
      github: () => ({
        getStatus: vi.fn().mockRejectedValue(new Error('offline')),
        createRegistration: vi.fn(async () => null),
        createEnabledClient: vi.fn(async () => null),
      }),
      receipts: new MemoryReceipts(),
    });
    await expect(withoutWeibo('channels_status', { projectId: PROJECT_ID })).resolves.toMatchObject(
      {
        data: {
          channels: expect.arrayContaining([
            expect.objectContaining({ channel: 'weibo', health: 'not-configured' }),
          ]),
        },
      },
    );

    expect(marketingOpsDataRoot()).toContain('Application Support/marketing-ops');
    expect(
      createDefaultBlueskyClient({
        handle: 'algorithms-visualization.bsky.social',
        appPassword: 'abcd-efgh-ijkl-mnop',
      }),
    ).toMatchObject({ checkHealth: expect.any(Function) });
    expect(createDefaultDevClient('dev-api-key-abcdefghijklmnop')).toMatchObject({
      checkHealth: expect.any(Function),
    });
    expect(
      createDefaultMastodonClient({
        instanceUrl: 'https://mastodon.social',
        accessToken: 'mastodon-access-token-abcdefghijklmnop',
      }),
    ).toMatchObject({ checkHealth: expect.any(Function) });
    expect(createDefaultGitHubController(PROJECT_PROFILE)).toBeTypeOf('object');
    expect(() =>
      createDefaultGitHubController({
        schemaVersion: 1,
        id: PROJECT_ID,
        displayName: 'No GitHub profile',
        canonicalOrigins: ['https://algo.illegalscreed.cn'],
        channels: ['bluesky'],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));

    const root = await mkdtemp(join(tmpdir(), 'marketing-ops-default-runtime-'));
    const emptyPath = join(root, 'empty-path');
    await mkdir(emptyPath);
    await new ProjectProfileStore(root).save({
      ...PROJECT_PROFILE,
      channels: ['github'],
      dev: undefined,
    });
    const previousPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      vi.resetModules();
      const { createDefaultLocalRuntimeToolHandler } = await import('./local-runtime.js');
      const defaultHandler = createDefaultLocalRuntimeToolHandler(root);
      await expect(
        defaultHandler('channels_status', { projectId: PROJECT_ID }),
      ).resolves.toMatchObject({
        data: {
          projectId: PROJECT_ID,
          channels: expect.arrayContaining([
            expect.objectContaining({ channel: 'github', adapterReady: false }),
          ]),
        },
      });
    } finally {
      vi.resetModules();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
