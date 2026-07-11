import { describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from './adapters/contract.js';
import {
  createDefaultLocalRuntimeToolHandler,
  createLocalRuntimeToolHandler,
  marketingOpsDataRoot,
} from './local-runtime.js';
import type { AdapterRegistration, ReceiptRepository } from './publish-service.js';
import type { PublishReceipt } from './receipt-store.js';
import { createPublishRequest } from './test-fixtures.js';

class MemoryReceipts implements ReceiptRepository {
  readonly values = new Map<string, PublishReceipt>();

  async getByIdempotencyKey(key: string) {
    return this.values.get(key) ?? null;
  }

  async save(receipt: PublishReceipt) {
    this.values.set(receipt.idempotencyKey, receipt);
    return { receipt, reused: false };
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
    };
    const handler = createLocalRuntimeToolHandler({
      github,
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

  it('TC-AUTO-RUNTIME-127-01 status 异常与默认工厂保持惰性失败关闭', async () => {
    const handler = createLocalRuntimeToolHandler({
      github: {
        getStatus: vi.fn().mockRejectedValue(new Error('Bearer private-token')),
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
    expect(JSON.stringify(status)).not.toContain('private-token');

    expect(marketingOpsDataRoot()).toContain('Application Support/marketing-ops');
    expect(createDefaultLocalRuntimeToolHandler('/tmp/marketing-ops-lazy-test')).toBeTypeOf(
      'function',
    );
  });
});
