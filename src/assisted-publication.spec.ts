import { describe, expect, it } from 'vitest';
import {
  ASSISTED_ADAPTER_VERSION,
  AssistedPublicationService,
  extractAssistedPostId,
} from './assisted-publication.js';
import type { PublishReceipt } from './receipt-store.js';
import { receiptProjectId } from './receipt-store.js';
import { createPublishRequest } from './test-fixtures.js';

class MemoryReceipts {
  readonly values = new Map<string, PublishReceipt>();

  async getByIdempotencyKey(key: string) {
    return this.values.get(key) ?? null;
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

  async save(receipt: PublishReceipt) {
    const existing = this.values.get(receipt.idempotencyKey);
    if (existing) return { receipt: existing, reused: true };
    this.values.set(receipt.idempotencyKey, receipt);
    return { receipt, reused: false };
  }
}

function request(channel: 'zhihu' | 'jianshu' | 'x' = 'zhihu', publicUrl?: string) {
  const base = createPublishRequest();
  const firstPackage = base.packages[0]!;
  const packageValue = {
    ...firstPackage,
    channel,
    format: 'manual-package' as const,
    variants: firstPackage.variants.map((variant) => ({ ...variant, media: [] })),
  };
  return {
    ...base,
    spec: { ...base.spec, channels: [channel] },
    packages: [packageValue],
    execution: publicUrl
      ? {
          mode: 'assisted-confirm' as const,
          confirmations: [{ channel, publicUrl }],
        }
      : { mode: 'assisted-prepare' as const },
  };
}

describe('assisted owner-confirmed publication', () => {
  it('TC-AUTO-ASSISTED-127-05 prepare 只返回可恢复 handoff 且零 receipt/外部调用', async () => {
    const receipts = new MemoryReceipts();
    const result = await new AssistedPublicationService({
      receipts,
      now: () => '2026-07-28T09:00:00.000Z',
    }).execute(request());

    expect(result).toMatchObject({
      projectId: 'algorithm-visualizer',
      campaignId: 'quick-sort-launch',
      receipts: [],
      failures: [],
      handoffs: [
        {
          channel: 'zhihu',
          status: 'awaiting-owner',
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          nextAction: 'Publish this package in the official UI, then confirm its public URL.',
        },
      ],
    });
    expect(receipts.values.size).toBe(0);
  });

  it('TC-AUTO-ASSISTED-127-06 confirm 校验平台 URL 后写入幂等 project receipt', async () => {
    const receipts = new MemoryReceipts();
    const service = new AssistedPublicationService({
      receipts,
      now: () => '2026-07-28T09:30:00.000Z',
    });
    const input = request('zhihu', 'https://zhuanlan.zhihu.com/p/123456789');

    const first = await service.execute(input);
    const second = await service.execute(input);

    expect(first).toMatchObject({
      receipts: [
        {
          schemaVersion: 2,
          projectId: 'algorithm-visualizer',
          channel: 'zhihu',
          postId: '123456789',
          publicUrl: 'https://zhuanlan.zhihu.com/p/123456789',
          publishedAt: '2026-07-28T09:30:00.000Z',
          adapterVersion: 'assisted-owner-confirmed@1.0.0',
          status: 'published',
        },
      ],
      handoffs: [{ status: 'confirmed', reused: false }],
    });
    expect(second).toMatchObject({ handoffs: [{ status: 'confirmed', reused: true }] });
    expect(receipts.values.size).toBe(1);
  });

  it('TC-AUTO-ASSISTED-127-07 错域、ID 缺失、凭据 URL 与 receipt 冲突失败关闭', async () => {
    const receipts = new MemoryReceipts();
    const service = new AssistedPublicationService({ receipts });

    await expect(
      service.execute(request('zhihu', 'https://attacker.example/p/123456789')),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.execute(request('x', 'https://x.com/illegalcreed/not-a-status')),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.execute(request('jianshu', 'https://user:pass@www.jianshu.com/p/abcdef123456')),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await service.execute(request('zhihu', 'https://zhuanlan.zhihu.com/p/123456789'));
    await expect(
      service.execute(request('zhihu', 'https://zhuanlan.zhihu.com/p/987654321')),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('TC-AUTO-ASSISTED-127-07 非法 URL、时间、模式与已登记引用全部失败关闭', async () => {
    const receipts = new MemoryReceipts();
    const service = new AssistedPublicationService({ receipts });

    for (const [channel, publicUrl] of [
      ['v2ex', `https://www.v2ex.com/t/${'1'.repeat(2_100)}`],
      ['v2ex', 'not-a-url'],
      ['v2ex', 'http://www.v2ex.com/t/123456'],
      ['hacker-news', 'https://news.ycombinator.com/news?id=987654'],
      ['hacker-news', 'https://news.ycombinator.com/item'],
      ['hacker-news', 'https://news.ycombinator.com/item?id=invalid'],
    ] as const) {
      expect(() => extractAssistedPostId(channel, publicUrl)).toThrow(/public url/i);
    }

    await expect(service.execute(createPublishRequest())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      new AssistedPublicationService({ receipts, now: () => 'invalid-time' }).execute(
        request('zhihu', 'https://zhuanlan.zhihu.com/p/123456789'),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    receipts.values.set('other-operation', {
      schemaVersion: 2,
      projectId: 'algorithm-visualizer',
      campaignId: 'other-campaign',
      channel: 'zhihu',
      postId: '123456789',
      publicUrl: 'https://zhuanlan.zhihu.com/p/123456789',
      publishedAt: '2026-07-28T09:00:00.000Z',
      contentHash: 'b'.repeat(64),
      idempotencyKey: 'other-operation',
      adapterVersion: ASSISTED_ADAPTER_VERSION,
      status: 'published',
    });
    await expect(
      service.execute(request('zhihu', 'https://zhuanlan.zhihu.com/p/123456789')),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('TC-AUTO-ASSISTED-127-07 多渠道任一公开引用非法时不写入部分 receipt', async () => {
    const receipts = new MemoryReceipts();
    const input = request('zhihu', 'https://zhuanlan.zhihu.com/p/123456789');
    const secondPackage = {
      ...input.packages[0],
      channel: 'jianshu' as const,
    };

    await expect(
      new AssistedPublicationService({ receipts }).execute({
        ...input,
        spec: { ...input.spec, channels: ['zhihu', 'jianshu'] },
        packages: [...input.packages, secondPackage],
        execution: {
          mode: 'assisted-confirm',
          confirmations: [
            { channel: 'zhihu', publicUrl: 'https://zhuanlan.zhihu.com/p/123456789' },
            { channel: 'jianshu', publicUrl: 'https://attacker.example/p/abcdef123456' },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(receipts.values.size).toBe(0);
  });

  it('TC-AUTO-ASSISTED-127-07 任一既有或落盘 receipt 字段冲突都失败关闭', async () => {
    const source = new MemoryReceipts();
    const input = request('zhihu', 'https://zhuanlan.zhihu.com/p/123456789');
    const result = await new AssistedPublicationService({
      receipts: source,
      now: () => '2026-07-28T09:30:00.000Z',
    }).execute(input);
    const receipt = result.receipts[0]!;
    const conflicts: PublishReceipt[] = [
      { ...receipt, schemaVersion: 1 },
      { ...receipt, projectId: 'other-project' },
      { ...receipt, campaignId: 'other-campaign' },
      { ...receipt, channel: 'jianshu' },
      { ...receipt, idempotencyKey: 'other-operation' },
      { ...receipt, contentHash: 'b'.repeat(64) },
      { ...receipt, postId: '987654321' },
      { ...receipt, publicUrl: 'https://zhuanlan.zhihu.com/p/987654321' },
      { ...receipt, adapterVersion: 'other-adapter@1.0.0' },
      { ...receipt, status: 'deleted' },
    ];
    for (const conflict of conflicts) {
      const values = new MemoryReceipts();
      values.values.set(receipt.idempotencyKey, conflict);
      await expect(
        new AssistedPublicationService({ receipts: values }).execute(input),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }

    const conflictingSave = {
      getByIdempotencyKey: async () => null,
      findKnownPostRef: async () => null,
      save: async () => ({
        receipt: { ...receipt, status: 'deleted' as const },
        reused: false,
      }),
    };
    await expect(
      new AssistedPublicationService({ receipts: conflictingSave }).execute(input),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('TC-AUTO-ASSISTED-127-09 支持平台 URL 只提取公开稳定 ID', () => {
    expect(extractAssistedPostId('v2ex', 'https://www.v2ex.com/t/123456')).toBe('123456');
    expect(
      extractAssistedPostId('hacker-news', 'https://news.ycombinator.com/item?id=987654'),
    ).toBe('987654');
    expect(
      extractAssistedPostId('product-hunt', 'https://www.producthunt.com/posts/content-studio'),
    ).toBe('content-studio');
    expect(extractAssistedPostId('juejin', 'https://juejin.cn/post/7123456789012345678')).toBe(
      '7123456789012345678',
    );
    expect(extractAssistedPostId('bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD')).toBe(
      'BV1xx411c7mD',
    );
    expect(extractAssistedPostId('bilibili', 'https://bilibili.com/video/av123456')).toBe(
      'av123456',
    );
    expect(
      extractAssistedPostId('zhihu', 'https://www.zhihu.com/question/123456789/answer/987654321'),
    ).toBe('987654321');
    expect(extractAssistedPostId('x', 'https://x.com/illegalcreed/status/1234567890')).toBe(
      '1234567890',
    );
    expect(extractAssistedPostId('jianshu', 'https://www.jianshu.com/p/abcdef123456')).toBe(
      'abcdef123456',
    );
    expect(
      extractAssistedPostId('facebook', 'https://www.facebook.com/illegalcreed/posts/1234567890'),
    ).toBe('1234567890');
    expect(
      extractAssistedPostId(
        'facebook',
        'https://m.facebook.com/permalink.php?story_fbid=ABC123&id=1',
      ),
    ).toBe('ABC123');
    expect(extractAssistedPostId('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
    expect(extractAssistedPostId('youtube', 'https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractAssistedPostId('youtube', 'https://youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
    expect(
      extractAssistedPostId('douyin', 'https://www.douyin.com/video/7123456789012345678'),
    ).toBe('7123456789012345678');
    expect(extractAssistedPostId('weibo', 'https://weibo.com/1234567890/AbCdEf123')).toBe(
      'AbCdEf123',
    );
  });
});
