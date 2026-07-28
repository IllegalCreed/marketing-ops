import { describe, expect, it, vi } from 'vitest';
import type { PublishReceipt } from './receipt-store.js';
import { receiptProjectId } from './receipt-store.js';
import { createLocalRuntimeToolHandler } from './local-runtime.js';
import { createPublishRequest } from './test-fixtures.js';

class MemoryReceipts {
  readonly values = new Map<string, PublishReceipt>();

  async getByIdempotencyKey(key: string) {
    return this.values.get(key) ?? null;
  }

  async save(receipt: PublishReceipt) {
    const existing = this.values.get(receipt.idempotencyKey);
    if (existing) return { receipt: existing, reused: true };
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
    postRef: { channel: PublishReceipt['channel']; postId: string; publicUrl: string },
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

  async findByPostRef() {
    return null;
  }

  async markDeleted(): Promise<PublishReceipt> {
    throw new Error('not used');
  }
}

function assisted(mode: 'assisted-prepare' | 'assisted-confirm') {
  const base = createPublishRequest();
  const firstPackage = base.packages[0]!;
  const packageValue = {
    ...firstPackage,
    channel: 'zhihu' as const,
    format: 'manual-package' as const,
    variants: firstPackage.variants.map((variant) => ({ ...variant, media: [] })),
  };
  return {
    ...base,
    spec: { ...base.spec, channels: ['zhihu'] as const },
    packages: [packageValue],
    execution:
      mode === 'assisted-prepare'
        ? { mode }
        : {
            mode,
            confirmations: [
              { channel: 'zhihu' as const, publicUrl: 'https://zhuanlan.zhihu.com/p/123456789' },
            ],
          },
  };
}

describe('T5 local runtime assisted handoff', () => {
  it('TC-AUTO-ASSISTED-127-10 prepare/confirm 不创建 adapter 写入，确认后 status/report 可恢复', async () => {
    const receipts = new MemoryReceipts();
    const createRegistration = vi.fn(async () => {
      throw new Error('automatic adapter must not be called');
    });
    let now = '2026-07-28T09:30:00.000Z';
    const handler = createLocalRuntimeToolHandler({
      projects: {
        require: vi.fn(async () => ({
          schemaVersion: 1 as const,
          id: 'algorithm-visualizer',
          displayName: 'Algorithm Visualizer',
          canonicalOrigins: ['https://algo.illegalscreed.cn'],
          channels: ['github' as const, 'zhihu' as const],
          github: { repository: 'IllegalCreed/algorithms-visualization' },
        })),
      },
      github: () => ({
        getStatus: vi.fn(),
        createRegistration,
        createEnabledClient: vi.fn(async () => null),
      }),
      receipts,
      now: () => now,
    });
    const handlerWithoutClock = createLocalRuntimeToolHandler({
      projects: {
        require: vi.fn(async () => ({
          schemaVersion: 1 as const,
          id: 'algorithm-visualizer',
          displayName: 'Algorithm Visualizer',
          canonicalOrigins: ['https://algo.illegalscreed.cn'],
          channels: ['github' as const, 'zhihu' as const],
          github: { repository: 'IllegalCreed/algorithms-visualization' },
        })),
      },
      github: () => ({
        getStatus: vi.fn(),
        createRegistration,
        createEnabledClient: vi.fn(async () => null),
      }),
      receipts,
    });

    await expect(handler('publish_campaign', assisted('assisted-prepare'))).resolves.toMatchObject({
      data: { receipts: [], handoffs: [{ status: 'awaiting-owner' }], followUps: [] },
    });
    await expect(
      handlerWithoutClock('publish_campaign', assisted('assisted-prepare')),
    ).resolves.toMatchObject({
      data: { handoffs: [{ status: 'awaiting-owner' }] },
    });
    await expect(handler('publish_campaign', assisted('assisted-confirm'))).resolves.toMatchObject({
      data: {
        receipts: [{ adapterVersion: 'assisted-owner-confirmed@1.0.0' }],
        followUps: [{ window: '1h' }, { window: '48h' }, { window: '7d' }],
      },
    });
    expect(createRegistration).not.toHaveBeenCalled();

    await expect(
      handler('get_publish_status', {
        projectId: 'algorithm-visualizer',
        campaignId: 'quick-sort-launch',
      }),
    ).resolves.toMatchObject({
      data: {
        status: 'complete',
        receipts: [{ channel: 'zhihu', status: 'published' }],
      },
    });

    now = '2026-07-28T10:30:00.000Z';
    await expect(
      handler('get_campaign_report', {
        projectId: 'algorithm-visualizer',
        campaignId: 'quick-sort-launch',
        window: '1h',
      }),
    ).resolves.toMatchObject({
      data: {
        status: 'unavailable',
        channels: [{ channel: 'zhihu', reason: 'collector-not-implemented' }],
      },
    });
  });
});
