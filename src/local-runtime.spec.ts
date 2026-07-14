import { describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from './adapters/contract.js';
import {
  createDefaultBlueskyClient,
  createDefaultLocalRuntimeToolHandler,
  createLocalRuntimeToolHandler,
  marketingOpsDataRoot,
} from './local-runtime.js';
import type { AdapterRegistration, ReceiptRepository } from './publish-service.js';
import type { PublishReceipt } from './receipt-store.js';
import { createBlueskyPublishRequest, createPublishRequest } from './test-fixtures.js';

class MemoryReceipts implements ReceiptRepository {
  readonly values = new Map<string, PublishReceipt>();

  async getByIdempotencyKey(key: string) {
    return this.values.get(key) ?? null;
  }

  async save(receipt: PublishReceipt) {
    this.values.set(receipt.idempotencyKey, receipt);
    return { receipt, reused: false };
  }

  async listByCampaign(campaignId: string) {
    return [...this.values.values()].filter((receipt) => receipt.campaignId === campaignId);
  }

  async findKnownPostRef(postRef: { channel: string; postId: string; publicUrl: string }) {
    return (
      [...this.values.values()].find(
        (receipt) =>
          receipt.channel === postRef.channel &&
          receipt.postId === postRef.postId &&
          receipt.publicUrl === postRef.publicUrl,
      ) ?? null
    );
  }

  async findByPostRef(
    campaignId: string,
    postRef: { channel: string; postId: string; publicUrl: string },
  ) {
    const receipt = await this.findKnownPostRef(postRef);
    return receipt?.campaignId === campaignId ? receipt : null;
  }

  async markDeleted(key: string) {
    const receipt = this.values.get(key);
    if (!receipt) throw new Error('not found');
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
        schemaVersion: 1 as const,
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
        schemaVersion: 1 as const,
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
      github,
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
      receipts: new MemoryReceipts(),
    });

    const status = await handler('channels_status', {});
    const data = status.data as {
      contractVersion: number;
      channels: Array<Record<string, unknown>>;
    };
    expect(data.contractVersion).toBe(2);
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
      github,
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
      github: {
        getStatus: vi.fn(),
        createRegistration: vi.fn(async () => null),
        createEnabledClient: vi.fn(async () => null),
      },
      bluesky,
      receipts,
    });
    const published = await handler('publish_campaign', createBlueskyPublishRequest());
    const receipt = (published.data as { receipts: PublishReceipt[] }).receipts[0]!;

    await expect(
      handler('delete_post', {
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
    expect((await receipts.listByCampaign(receipt.campaignId))[0]).toMatchObject({
      status: 'deleted',
    });
    expect(bluesky.createRegistration).toHaveBeenCalledTimes(2);
  });

  it('TC-AUTO-RUNTIME-127-01 status 异常与默认工厂保持惰性失败关闭', async () => {
    const handler = createLocalRuntimeToolHandler({
      github: {
        getStatus: vi.fn().mockRejectedValue(new Error('Bearer private-token')),
        createRegistration: vi.fn(async () => null),
        createEnabledClient: vi.fn(async () => null),
      },
      weibo: {
        getStatus: vi.fn().mockRejectedValue(new Error('cookie private-cookie')),
      },
      bluesky: {
        getStatus: vi.fn().mockRejectedValue(new Error('app-password private-secret')),
        createRegistration: vi.fn(async () => null),
      },
      receipts: new MemoryReceipts(),
    });
    const status = await handler('channels_status', {});
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
    expect(JSON.stringify(status)).not.toContain('private-token');
    expect(JSON.stringify(status)).not.toContain('private-cookie');
    expect(JSON.stringify(status)).not.toContain('private-secret');

    const withoutWeibo = createLocalRuntimeToolHandler({
      github: {
        getStatus: vi.fn().mockRejectedValue(new Error('offline')),
        createRegistration: vi.fn(async () => null),
        createEnabledClient: vi.fn(async () => null),
      },
      receipts: new MemoryReceipts(),
    });
    await expect(withoutWeibo('channels_status', {})).resolves.toMatchObject({
      data: {
        channels: expect.arrayContaining([
          expect.objectContaining({ channel: 'weibo', health: 'not-configured' }),
        ]),
      },
    });

    expect(marketingOpsDataRoot()).toContain('Application Support/marketing-ops');
    expect(
      createDefaultBlueskyClient({
        handle: 'algorithms-visualization.bsky.social',
        appPassword: 'abcd-efgh-ijkl-mnop',
      }),
    ).toMatchObject({ checkHealth: expect.any(Function) });
    expect(createDefaultLocalRuntimeToolHandler('/tmp/marketing-ops-lazy-test')).toBeTypeOf(
      'function',
    );
  });
});
