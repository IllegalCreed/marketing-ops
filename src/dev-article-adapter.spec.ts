import { describe, expect, it, vi } from 'vitest';
import { AdapterTransportError, requireAdapterCapability } from './adapters/contract.js';
import {
  DevArticleAdapter,
  buildDevArticleDraft,
  type DevArticleClient,
  type DevArticleRecord,
} from './adapters/dev-article.js';

const CANONICAL_URL = 'https://algo.illegalscreed.cn/en/docs/quick-sort/';
const TRACKED_URL = `${CANONICAL_URL}?utm_source=dev&utm_medium=community&utm_campaign=launch&utm_content=dev-en-link-1`;
const PROJECT_POLICY = {
  canonicalOrigins: ['https://algo.illegalscreed.cn'],
  tags: ['algorithms', 'webdev', 'opensource'],
};

function channelPackage() {
  return {
    channel: 'dev' as const,
    format: 'article' as const,
    utmMedium: 'community' as const,
    canonicalUrl: CANONICAL_URL,
    variants: [
      {
        locale: 'en' as const,
        title: 'Quick Sort, visualized step by step',
        body: `Trace partitioning step by step.\n\n[Explore](${TRACKED_URL})`,
        links: [TRACKED_URL],
        media: [] as Array<'image' | 'gif' | 'video'>,
      },
    ],
  };
}

function input() {
  return {
    projectId: 'algorithm-visualizer',
    campaignId: 'quick-sort-launch',
    idempotencyKey: 'campaign-v2/quick-sort-launch/dev-1234',
    contentHash: 'd'.repeat(64),
    package: channelPackage(),
  };
}

function draft(value: unknown = input()) {
  return buildDevArticleDraft(value, PROJECT_POLICY);
}

function createAdapter(clientValue: DevArticleClient) {
  return new DevArticleAdapter({ client: clientValue, ...PROJECT_POLICY });
}

function record(bodyMarkdown = draft().bodyMarkdown): DevArticleRecord {
  return {
    id: 321,
    title: channelPackage().variants[0]!.title,
    bodyMarkdown,
    canonicalUrl: CANONICAL_URL,
    publicUrl: 'https://dev.to/algorithmviz/quick-sort-visualized-1234',
    publishedAt: '2026-07-15T01:00:00.000Z',
    commentsCount: 0,
    publicReactionsCount: 0,
    positiveReactionsCount: 0,
  };
}

function client(existing: DevArticleRecord | null = null) {
  return {
    findArticle: vi
      .fn<DevArticleClient['findArticle']>()
      .mockResolvedValue({ complete: true, article: existing }),
    createArticle: vi
      .fn<DevArticleClient['createArticle']>()
      .mockImplementation(async (draft) => record(draft.bodyMarkdown)),
  };
}

describe('DEV article adapter', () => {
  it('TC-AUTO-DEVADAPTER-127-01 draft 复用单英文 renderer 并添加确定性隐藏 marker', () => {
    const first = draft();
    const second = draft();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      title: channelPackage().variants[0]!.title,
      canonicalUrl: CANONICAL_URL,
      published: true,
      tags: 'algorithms, opensource, webdev',
    });
    expect(first.bodyMarkdown).toContain('<!-- marketing-ops:v2 project=algorithm-visualizer');
    expect(first.bodyMarkdown).toContain(TRACKED_URL);
    expect(first.bodyMarkdown).not.toContain(input().idempotencyKey);
  });

  it('TC-AUTO-DEVADAPTER-127-02 完整查询命中同正文时幂等复用', async () => {
    const fake = client(record());
    const result = await createAdapter(fake).publish(input());

    expect(result).toMatchObject({
      reused: true,
      receipt: {
        channel: 'dev',
        postId: '321',
        adapterVersion: 'dev-article@0.2.0',
        status: 'published',
      },
    });
    expect(fake.createArticle).not.toHaveBeenCalled();
  });

  it('TC-AUTO-DEVADAPTER-127-03 不完整、畸形与冲突查询禁止 create', async () => {
    const incomplete = client();
    incomplete.findArticle.mockResolvedValueOnce({ complete: false, article: null });
    await expect(createAdapter(incomplete).publish(input())).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
      stage: 'before-submit',
    });

    const malformed = client();
    malformed.findArticle.mockResolvedValueOnce({ complete: true } as never);
    await expect(createAdapter(malformed).publish(input())).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
    });

    const conflict = client(record('different body'));
    await expect(createAdapter(conflict).publish(input())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const invalidRecord = client({ ...record(), publicUrl: 'https://example.com/article' });
    await expect(createAdapter(invalidRecord).publish(input())).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
      stage: 'before-submit',
    });
    expect(incomplete.createArticle).not.toHaveBeenCalled();
    expect(malformed.createArticle).not.toHaveBeenCalled();
    expect(conflict.createArticle).not.toHaveBeenCalled();
    expect(invalidRecord.createArticle).not.toHaveBeenCalled();
  });

  it('TC-AUTO-DEVADAPTER-127-04 创建结果严格对拍并映射 receipt', async () => {
    const fake = client();
    await expect(createAdapter(fake).publish(input())).resolves.toMatchObject({
      reused: false,
      receipt: { channel: 'dev', postId: '321', publicUrl: record().publicUrl },
    });
    expect(fake.createArticle).toHaveBeenCalledWith(draft());

    fake.createArticle.mockResolvedValueOnce(record('different body'));
    await expect(createAdapter(fake).publish(input())).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });
    fake.createArticle.mockResolvedValueOnce({ ...record(), id: 0 });
    await expect(createAdapter(fake).publish(input())).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });
  });

  it('TC-AUTO-DEVADAPTER-127-05 认证、限流与提交后未知结果沿共享错误合同映射', async () => {
    const auth = client();
    auth.findArticle.mockRejectedValueOnce(
      new AdapterTransportError('private', { status: 401, stage: 'before-submit' }),
    );
    await expect(createAdapter(auth).publish(input())).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });

    const rate = client();
    rate.findArticle.mockRejectedValueOnce(
      new AdapterTransportError('rate', {
        status: 429,
        stage: 'before-submit',
        retryAfterSeconds: 120,
      }),
    );
    await expect(createAdapter(rate).publish(input())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 120,
    });

    const unknown = client();
    unknown.createArticle.mockRejectedValueOnce(
      new AdapterTransportError('dropped', { timeout: true, stage: 'after-submit' }),
    );
    await expect(createAdapter(unknown).publish(input())).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });
  });

  it('TC-AUTO-DEVADAPTER-127-06 媒体、中文、多变体、丢链接与错 canonical 失败关闭', async () => {
    const fake = client();
    const adapter = createAdapter(fake);
    const invalidPackages = [
      {
        ...channelPackage(),
        variants: [{ ...channelPackage().variants[0], media: ['image' as const] }],
      },
      {
        ...channelPackage(),
        variants: [{ ...channelPackage().variants[0], locale: 'zh-CN' as const }],
      },
      {
        ...channelPackage(),
        variants: [channelPackage().variants[0], channelPackage().variants[0]],
      },
      {
        ...channelPackage(),
        variants: [{ ...channelPackage().variants[0], body: 'link removed' }],
      },
      { ...channelPackage(), canonicalUrl: 'https://example.com/quick-sort/' },
    ];

    for (const packageValue of invalidPackages) {
      await expect(
        adapter.publish({ ...input(), package: packageValue as never }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/INVALID_CONTENT|UNRESOLVED_MEDIA/),
      });
    }
    for (const policy of [
      { canonicalOrigins: [], tags: ['algorithms'] },
      { canonicalOrigins: ['not-a-url'], tags: ['algorithms'] },
      { canonicalOrigins: ['https://algo.illegalscreed.cn/path'], tags: ['algorithms'] },
      { canonicalOrigins: ['https://algo.illegalscreed.cn'], tags: [] },
      {
        canonicalOrigins: ['https://algo.illegalscreed.cn'],
        tags: ['one', 'two', 'three', 'four', 'five'],
      },
      { canonicalOrigins: ['https://algo.illegalscreed.cn'], tags: ['Bad Tag'] },
    ]) {
      expect(() => new DevArticleAdapter({ client: fake, ...policy })).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONTENT' }),
      );
    }
    expect(fake.findArticle).not.toHaveBeenCalled();
  });

  it('TC-AUTO-DEVADAPTER-127-07 能力明确支持状态/指标/反馈但禁用回复与删除', () => {
    const adapter = createAdapter(client());
    expect(adapter.definition.capabilities).toEqual({
      publish: true,
      status: true,
      metrics: true,
      feedback: true,
      reply: false,
      delete: false,
    });
    for (const operation of ['status', 'metrics', 'feedback'] as const) {
      expect(() => requireAdapterCapability(adapter.definition, operation)).not.toThrow();
    }
    for (const operation of ['reply', 'delete'] as const) {
      expect(() => requireAdapterCapability(adapter.definition, operation)).toThrowError(
        expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
      );
    }
  });
});
