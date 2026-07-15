import { describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from './adapters/contract.js';
import type { DevObservabilityClient } from './dev-observability.js';
import { createLocalRuntimeToolHandler } from './local-runtime.js';
import type { AdapterRegistration, ReceiptRepository } from './publish-service.js';
import type { PublishReceipt } from './receipt-store.js';
import { createDevPublishRequest } from './test-fixtures.js';

const PUBLIC_URL = 'https://dev.to/algorithmviz/quick-sort-visualized-1234';

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

function devAdapter(): ChannelAdapter {
  return {
    definition: {
      channel: 'dev',
      version: 'dev-article@0.1.0',
      capabilities: {
        publish: true,
        status: true,
        metrics: true,
        feedback: true,
        reply: false,
        delete: false,
      },
    },
    expectedFormat: 'article',
    preflight: vi.fn(async () => undefined),
    publish: vi.fn<ChannelAdapter['publish']>(async (input) => ({
      reused: false,
      receipt: {
        schemaVersion: 1,
        campaignId: input.campaignId,
        channel: 'dev',
        postId: '321',
        publicUrl: PUBLIC_URL,
        publishedAt: '2026-07-15T01:00:00.000Z',
        contentHash: input.contentHash,
        idempotencyKey: input.idempotencyKey,
        adapterVersion: 'dev-article@0.1.0',
        status: 'published',
      },
    })),
  };
}

function observability(): DevObservabilityClient {
  return {
    getArticle: vi.fn(async () => ({
      id: 321,
      title: 'Quick Sort visualization is live',
      bodyMarkdown: 'Body',
      canonicalUrl: 'https://algo.illegalscreed.cn/en/docs/quick-sort/',
      publicUrl: PUBLIC_URL,
      publishedAt: '2026-07-15T01:00:00.000Z',
      commentsCount: 1,
      publicReactionsCount: 3,
      positiveReactionsCount: 2,
    })),
    listComments: vi.fn(async () => [
      {
        id: 'comment1',
        bodyHtml: '<p>Helpful article.</p>',
        createdAt: '2026-07-15T02:00:00.000Z',
        authorAlias: 'reader',
        children: [],
      },
    ]),
  };
}

function github() {
  return {
    getStatus: vi.fn(async () => ({
      channel: 'github' as const,
      alias: null,
      health: 'not-configured' as const,
      adapterReady: false,
      nextAction: 'Run marketing-ops setup github',
    })),
    createRegistration: vi.fn(async () => null),
    createEnabledClient: vi.fn(async () => null),
  };
}

function dev(ready = true) {
  const adapter = devAdapter();
  const client = observability();
  return {
    adapter,
    client,
    getStatus: vi.fn(async () => ({
      channel: 'dev' as const,
      alias: ready ? 'algorithmviz' : null,
      health: ready ? ('ready' as const) : ('not-configured' as const),
      adapterReady: ready,
      nextAction: ready ? null : 'Run marketing-ops setup dev',
    })),
    createRegistration: vi.fn(async (): Promise<AdapterRegistration | null> =>
      ready ? { adapter, enabled: true, health: 'ready' } : null,
    ),
    createEnabledClient: vi.fn(async () => (ready ? client : null)),
  };
}

describe('local DEV runtime wiring', () => {
  it('TC-AUTO-DEVRUNTIME-127-01 status 动态且只为 DEV package 惰性注册', async () => {
    const controller = dev();
    const handler = createLocalRuntimeToolHandler({
      github: github(),
      dev: controller,
      receipts: new MemoryReceipts(),
    });

    await expect(handler('channels_status', {})).resolves.toMatchObject({
      data: {
        channels: expect.arrayContaining([
          expect.objectContaining({
            channel: 'dev',
            alias: 'algorithmviz',
            health: 'ready',
            adapterReady: true,
          }),
        ]),
      },
    });
    await expect(handler('publish_campaign', createDevPublishRequest())).resolves.toMatchObject({
      data: { receipts: [{ channel: 'dev', postId: '321' }], failures: [] },
    });
    expect(controller.createRegistration).toHaveBeenCalledOnce();
    expect(controller.adapter.publish).toHaveBeenCalledOnce();
  });

  it('TC-AUTO-DEVRUNTIME-127-02 feedback/report 只读取已知已发布 receipt', async () => {
    const controller = dev();
    const receipts = new MemoryReceipts();
    const handler = createLocalRuntimeToolHandler({ github: github(), dev: controller, receipts });
    const published = await handler('publish_campaign', createDevPublishRequest());
    const receipt = (published.data as { receipts: PublishReceipt[] }).receipts[0]!;
    const postRef = {
      channel: receipt.channel,
      postId: receipt.postId,
      publicUrl: receipt.publicUrl,
    };

    await expect(handler('list_feedback', { postRef })).resolves.toMatchObject({
      data: { items: [{ kind: 'comment', untrusted: true }], nextCursor: null },
    });
    await expect(
      handler('get_campaign_report', { campaignId: receipt.campaignId, window: '48h' }),
    ).resolves.toMatchObject({
      data: {
        status: 'available',
        channels: [expect.objectContaining({ channel: 'dev', attribution: 'post-level' })],
      },
    });
    expect(controller.createEnabledClient).toHaveBeenCalledTimes(2);

    await expect(
      handler('list_feedback', {
        postRef: { ...postRef, postId: '999' },
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'INVALID_INPUT' } });
  });

  it('TC-AUTO-DEVRUNTIME-127-03 reply/delete 与失去健康状态均失败关闭', async () => {
    const controller = dev();
    const receipts = new MemoryReceipts();
    const handler = createLocalRuntimeToolHandler({ github: github(), dev: controller, receipts });
    const published = await handler('publish_campaign', createDevPublishRequest());
    const receipt = (published.data as { receipts: PublishReceipt[] }).receipts[0]!;
    const postRef = {
      channel: receipt.channel,
      postId: receipt.postId,
      publicUrl: receipt.publicUrl,
    };
    const authorization = {
      source: 'owner-prompt',
      authorizedAt: '2026-07-15T03:00:00.000Z',
    };

    await expect(
      handler('delete_post', {
        campaignId: receipt.campaignId,
        postRef,
        idempotencyKey: 'delete/quick-sort-launch/dev-0001',
        authorization,
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
    await expect(
      handler('reply_feedback', {
        campaignId: receipt.campaignId,
        postRef,
        commentId: 'comment1',
        body: 'Thanks.',
        policy: 'faq-only',
        idempotencyKey: 'reply/quick-sort-launch/dev-0001',
        authorization,
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });

    const disabled = createLocalRuntimeToolHandler({
      github: github(),
      dev: dev(false),
      receipts,
    });
    await expect(disabled('list_feedback', { postRef })).resolves.toMatchObject({
      isError: true,
      data: { code: 'ADAPTER_UNAVAILABLE' },
    });

    const withoutDev = createLocalRuntimeToolHandler({ github: github(), receipts });
    await expect(withoutDev('list_feedback', { postRef })).resolves.toMatchObject({
      isError: true,
      data: { code: 'ADAPTER_UNAVAILABLE' },
    });
    await expect(
      withoutDev('get_campaign_report', { campaignId: receipt.campaignId, window: '1h' }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
  });

  it('TC-AUTO-DEVRUNTIME-127-04 状态异常失败关闭且不泄露 API key', async () => {
    const controller = dev();
    controller.getStatus.mockRejectedValueOnce(new Error('private dev-api-key-abcdefghijklmnop'));
    const handler = createLocalRuntimeToolHandler({
      github: github(),
      dev: controller,
      receipts: new MemoryReceipts(),
    });
    const status = await handler('channels_status', {});

    expect(status).toMatchObject({
      data: {
        channels: expect.arrayContaining([
          expect.objectContaining({ channel: 'dev', health: 'blocked', adapterReady: false }),
        ]),
      },
    });
    expect(JSON.stringify(status)).not.toContain('dev-api-key-abcdefghijklmnop');
  });
});
