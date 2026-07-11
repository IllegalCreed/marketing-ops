import { describe, expect, it, vi } from 'vitest';
import { AdapterTransportError, requireAdapterCapability } from './adapters/contract.js';
import {
  buildWeiboTextDraft,
  WeiboTextAdapter,
  type WeiboPostRecord,
  type WeiboTextClient,
} from './adapters/weibo-post.js';

function createPackage(media: Array<'image' | 'gif' | 'video'> = []) {
  return {
    channel: 'weibo' as const,
    format: 'post' as const,
    utmMedium: 'social' as const,
    variants: [
      {
        locale: 'zh-CN' as const,
        title: '快速排序可视化已上线',
        body: '快速排序可视化已上线\n\n逐步观察分区过程。\n\n打开可视化: https://algo.illegalscreed.cn/docs/quick-sort/?utm_source=weibo&utm_medium=social&utm_campaign=launch',
        links: [
          'https://algo.illegalscreed.cn/docs/quick-sort/?utm_source=weibo&utm_medium=social&utm_campaign=launch',
        ],
        media,
      },
    ],
  };
}

function input() {
  return {
    campaignId: 'quick-sort-launch',
    idempotencyKey: 'campaign-v2/quick-sort-launch/weibo-1234',
    contentHash: 'a'.repeat(64),
    package: createPackage(),
  };
}

function postBody(): string {
  return createPackage().variants[0]!.body;
}

function record(text = postBody()): WeiboPostRecord {
  return {
    id: '5226761046462968',
    text,
    publicUrl: 'https://weibo.com/123456/AbCdEf',
    publishedAt: '2026-07-11T00:00:00.000Z',
  };
}

function client(existing: WeiboPostRecord | null = null) {
  return {
    findRecentPostByText: vi
      .fn<WeiboTextClient['findRecentPostByText']>()
      .mockResolvedValue({ complete: true, post: existing }),
    createTextPost: vi
      .fn<WeiboTextClient['createTextPost']>()
      .mockImplementation(async (draft) => record(draft.text)),
  };
}

describe('Weibo text adapter with typed fake client', () => {
  it('TC-AUTO-WBADAPTER-127-01 draft 完全复用 renderer 的单个中文正文', () => {
    const first = buildWeiboTextDraft(input());
    const second = buildWeiboTextDraft(input());

    expect(first).toEqual(second);
    expect(first).toEqual({ text: postBody() });
    expect(first.text).toContain('utm_source=weibo');
    expect(first.text).not.toContain(input().idempotencyKey);
  });

  it('TC-AUTO-WBADAPTER-127-02 完整最近列表命中同正文时幂等复用', async () => {
    const fake = client(record());
    const result = await new WeiboTextAdapter({ client: fake }).publish(input());

    expect(result).toMatchObject({
      reused: true,
      receipt: { channel: 'weibo', postId: '5226761046462968', status: 'published' },
    });
    expect(fake.findRecentPostByText).toHaveBeenCalledWith(postBody());
    expect(fake.createTextPost).not.toHaveBeenCalled();
  });

  it('TC-AUTO-WBADAPTER-127-02 查询不完整时禁止 create', async () => {
    const fake = client();
    fake.findRecentPostByText.mockResolvedValueOnce({ complete: false, post: null });

    await expect(new WeiboTextAdapter({ client: fake }).publish(input())).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
      stage: 'before-submit',
    });
    expect(fake.createTextPost).not.toHaveBeenCalled();
  });

  it('TC-AUTO-WBADAPTER-127-02 畸形或冲突的最近发布查询失败关闭', async () => {
    const malformed = client();
    malformed.findRecentPostByText.mockResolvedValueOnce({ complete: true } as never);
    await expect(
      new WeiboTextAdapter({ client: malformed }).publish(input()),
    ).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE', stage: 'before-submit' });

    const invalidRecord = client({ ...record(), publicUrl: 'https://example.com/post' });
    await expect(
      new WeiboTextAdapter({ client: invalidRecord }).publish(input()),
    ).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE', stage: 'before-submit' });

    const conflict = client(record('different text'));
    await expect(new WeiboTextAdapter({ client: conflict }).publish(input())).rejects.toMatchObject(
      { code: 'IDEMPOTENCY_CONFLICT', stage: 'before-submit' },
    );
  });

  it('TC-AUTO-WBADAPTER-127-03 创建结果严格对拍并映射公开 receipt', async () => {
    const fake = client();
    const result = await new WeiboTextAdapter({ client: fake }).publish(input());

    expect(result).toMatchObject({
      reused: false,
      receipt: {
        channel: 'weibo',
        postId: '5226761046462968',
        publicUrl: 'https://weibo.com/123456/AbCdEf',
        adapterVersion: 'weibo-text@0.1.0',
        status: 'published',
      },
    });
    expect(fake.createTextPost).toHaveBeenCalledWith({ text: postBody() });

    fake.createTextPost.mockResolvedValueOnce(record('different text'));
    await expect(new WeiboTextAdapter({ client: fake }).publish(input())).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });

    fake.createTextPost.mockResolvedValueOnce({ ...record(), id: 'invalid' });
    await expect(new WeiboTextAdapter({ client: fake }).publish(input())).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });
  });

  it('TC-AUTO-WBADAPTER-127-04 认证、限流和提交后未知结果沿共享错误合同映射', async () => {
    const auth = client();
    auth.findRecentPostByText.mockRejectedValueOnce(
      new AdapterTransportError('Bearer private-token', { status: 401, stage: 'before-submit' }),
    );
    await expect(new WeiboTextAdapter({ client: auth }).publish(input())).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });

    const denied = client();
    denied.findRecentPostByText.mockRejectedValueOnce(
      new AdapterTransportError('denied', { status: 403, stage: 'before-submit' }),
    );
    await expect(new WeiboTextAdapter({ client: denied }).publish(input())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });

    const rate = client();
    rate.findRecentPostByText.mockRejectedValueOnce(
      new AdapterTransportError('rate', {
        status: 429,
        stage: 'before-submit',
        retryAfterSeconds: 900,
      }),
    );
    await expect(new WeiboTextAdapter({ client: rate }).publish(input())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 900,
    });

    const server = client();
    server.findRecentPostByText.mockRejectedValueOnce(
      new AdapterTransportError('server', { status: 503, stage: 'before-submit' }),
    );
    await expect(new WeiboTextAdapter({ client: server }).publish(input())).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
      retryable: true,
    });

    const unknown = client();
    unknown.createTextPost.mockRejectedValueOnce(
      new AdapterTransportError('connection dropped', {
        timeout: true,
        stage: 'after-submit',
      }),
    );
    await expect(new WeiboTextAdapter({ client: unknown }).publish(input())).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });
  });

  it('TC-AUTO-WBADAPTER-127-05 媒体、英文、多变体与未落地能力全部失败关闭', async () => {
    const fake = client();
    await expect(
      new WeiboTextAdapter({ client: fake }).publish({
        ...input(),
        package: createPackage(['image']),
      }),
    ).rejects.toMatchObject({ code: 'UNRESOLVED_MEDIA' });

    const english = {
      ...createPackage(),
      variants: [{ ...createPackage().variants[0]!, locale: 'en' as const }],
    };
    await expect(
      new WeiboTextAdapter({ client: fake }).publish({ ...input(), package: english }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });

    const oversized = createPackage();
    oversized.variants[0]!.body = '长'.repeat(2_001);
    await expect(
      new WeiboTextAdapter({ client: fake }).publish({ ...input(), package: oversized }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });

    const missingLink = createPackage();
    missingLink.variants[0]!.body = '正文没有 renderer 生成的目标链接';
    await expect(
      new WeiboTextAdapter({ client: fake }).publish({ ...input(), package: missingLink }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });

    const adapter = new WeiboTextAdapter({ client: fake });
    expect(adapter.definition.capabilities).toEqual({
      publish: true,
      status: false,
      metrics: false,
      feedback: false,
      reply: false,
      delete: false,
    });
    for (const operation of ['status', 'metrics', 'feedback', 'reply', 'delete'] as const) {
      expect(() => requireAdapterCapability(adapter.definition, operation)).toThrowError(
        expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
      );
    }
    expect(fake.findRecentPostByText).not.toHaveBeenCalled();
    expect(fake.createTextPost).not.toHaveBeenCalled();
  });
});
