import { describe, expect, it, vi } from 'vitest';
import { AdapterTransportError, requireAdapterCapability } from './adapters/contract.js';
import {
  BlueskyTextAdapter,
  buildBlueskyTextDraft,
  type BlueskyPostRecord,
  type BlueskyTextClient,
} from './adapters/bluesky-post.js';

const TARGET_URL =
  'https://algo.illegalscreed.cn/en/docs/quick-sort/?utm_source=bluesky&utm_medium=social&utm_campaign=launch';

function createPackage(media: Array<'image' | 'gif' | 'video'> = []) {
  return {
    channel: 'bluesky' as const,
    format: 'post' as const,
    utmMedium: 'social' as const,
    variants: [
      {
        locale: 'en' as const,
        title: 'Quick Sort visualization is live',
        body: `Quick Sort visualization is live\n\nTrace partitioning step by step.\n\nOpen the visualization: ${TARGET_URL}`,
        links: [TARGET_URL],
        media,
      },
    ],
  };
}

function input() {
  return {
    campaignId: 'quick-sort-launch',
    idempotencyKey: 'campaign-v2/quick-sort-launch/bluesky-1234',
    contentHash: 'b'.repeat(64),
    package: createPackage(),
  };
}

function postBody(): string {
  return createPackage().variants[0]!.body;
}

function record(text = postBody()): BlueskyPostRecord {
  return {
    uri: 'at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3ltx4abcde22a',
    cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    text,
    publicUrl: 'https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/post/3ltx4abcde22a',
    publishedAt: '2026-07-14T09:00:00.000Z',
  };
}

function client(existing: BlueskyPostRecord | null = null) {
  return {
    findRecentPostByText: vi
      .fn<BlueskyTextClient['findRecentPostByText']>()
      .mockResolvedValue({ complete: true, post: existing }),
    createTextPost: vi
      .fn<BlueskyTextClient['createTextPost']>()
      .mockImplementation(async (draft) => record(draft.text)),
  };
}

describe('Bluesky text adapter with typed fake client', () => {
  it('TC-AUTO-BSKYADAPTER-127-01 draft 完全复用 renderer 的单个英文正文', () => {
    const first = buildBlueskyTextDraft(input());
    const second = buildBlueskyTextDraft(input());

    expect(first).toEqual(second);
    expect(first).toEqual({ text: postBody(), langs: ['en'] });
    expect(first.text).toContain('utm_source=bluesky');
    expect(first.text).not.toContain(input().idempotencyKey);
  });

  it('TC-AUTO-BSKYADAPTER-127-02 完整最近列表命中同正文时幂等复用', async () => {
    const fake = client(record());
    const result = await new BlueskyTextAdapter({ client: fake }).publish(input());

    expect(result).toMatchObject({
      reused: true,
      receipt: {
        channel: 'bluesky',
        postId: record().uri,
        status: 'published',
      },
    });
    expect(fake.findRecentPostByText).toHaveBeenCalledWith(postBody());
    expect(fake.createTextPost).not.toHaveBeenCalled();
  });

  it('TC-AUTO-BSKYADAPTER-127-02B 不完整、畸形与冲突查询均禁止 create', async () => {
    const incomplete = client();
    incomplete.findRecentPostByText.mockResolvedValueOnce({ complete: false, post: null });
    await expect(
      new BlueskyTextAdapter({ client: incomplete }).publish(input()),
    ).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE', stage: 'before-submit' });

    const malformed = client();
    malformed.findRecentPostByText.mockResolvedValueOnce({ complete: true } as never);
    await expect(
      new BlueskyTextAdapter({ client: malformed }).publish(input()),
    ).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE', stage: 'before-submit' });

    const invalidRecord = client({ ...record(), publicUrl: 'https://example.com/post' });
    await expect(
      new BlueskyTextAdapter({ client: invalidRecord }).publish(input()),
    ).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE', stage: 'before-submit' });

    const conflict = client(record('different text'));
    await expect(
      new BlueskyTextAdapter({ client: conflict }).publish(input()),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', stage: 'before-submit' });

    expect(incomplete.createTextPost).not.toHaveBeenCalled();
    expect(malformed.createTextPost).not.toHaveBeenCalled();
    expect(invalidRecord.createTextPost).not.toHaveBeenCalled();
    expect(conflict.createTextPost).not.toHaveBeenCalled();
  });

  it('TC-AUTO-BSKYADAPTER-127-03 创建结果严格对拍并映射公开 receipt', async () => {
    const fake = client();
    const result = await new BlueskyTextAdapter({ client: fake }).publish(input());

    expect(result).toMatchObject({
      reused: false,
      receipt: {
        channel: 'bluesky',
        postId: record().uri,
        publicUrl: record().publicUrl,
        adapterVersion: 'bluesky-text@0.1.0',
        status: 'published',
      },
    });
    expect(fake.createTextPost).toHaveBeenCalledWith({ text: postBody(), langs: ['en'] });

    fake.createTextPost.mockResolvedValueOnce(record('different text'));
    await expect(new BlueskyTextAdapter({ client: fake }).publish(input())).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });

    fake.createTextPost.mockResolvedValueOnce({ ...record(), uri: 'invalid' });
    await expect(new BlueskyTextAdapter({ client: fake }).publish(input())).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });
  });

  it('TC-AUTO-BSKYADAPTER-127-04 认证、限流和提交后未知结果沿共享错误合同映射', async () => {
    for (const [status, code] of [
      [401, 'REAUTH_REQUIRED'],
      [403, 'PERMISSION_DENIED'],
      [503, 'TEMPORARY_FAILURE'],
    ] as const) {
      const fake = client();
      fake.findRecentPostByText.mockRejectedValueOnce(
        new AdapterTransportError('private response', { status, stage: 'before-submit' }),
      );
      await expect(new BlueskyTextAdapter({ client: fake }).publish(input())).rejects.toMatchObject(
        { code },
      );
    }

    const rate = client();
    rate.findRecentPostByText.mockRejectedValueOnce(
      new AdapterTransportError('rate', {
        status: 429,
        stage: 'before-submit',
        retryAfterSeconds: 120,
      }),
    );
    await expect(new BlueskyTextAdapter({ client: rate }).publish(input())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 120,
    });

    const unknown = client();
    unknown.createTextPost.mockRejectedValueOnce(
      new AdapterTransportError('connection dropped', {
        timeout: true,
        stage: 'after-submit',
      }),
    );
    await expect(
      new BlueskyTextAdapter({ client: unknown }).publish(input()),
    ).rejects.toMatchObject({ code: 'UNKNOWN_RESULT', lookupRequired: true });
  });

  it('TC-AUTO-BSKYADAPTER-127-05 媒体、中文、多变体、超长与丢链接全部失败关闭', async () => {
    const fake = client();
    await expect(
      new BlueskyTextAdapter({ client: fake }).publish({
        ...input(),
        package: createPackage(['image']),
      }),
    ).rejects.toMatchObject({ code: 'UNRESOLVED_MEDIA' });

    const chinese = {
      ...createPackage(),
      variants: [{ ...createPackage().variants[0]!, locale: 'zh-CN' as const }],
    };
    await expect(
      new BlueskyTextAdapter({ client: fake }).publish({ ...input(), package: chinese }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });

    const multiple = createPackage();
    multiple.variants.push({ ...multiple.variants[0]! });
    await expect(
      new BlueskyTextAdapter({ client: fake }).publish({ ...input(), package: multiple }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });

    const oversized = createPackage();
    oversized.variants[0]!.body = 'a'.repeat(301);
    await expect(
      new BlueskyTextAdapter({ client: fake }).publish({ ...input(), package: oversized }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });

    const missingLink = createPackage();
    missingLink.variants[0]!.body = 'Renderer target link was removed';
    await expect(
      new BlueskyTextAdapter({ client: fake }).publish({ ...input(), package: missingLink }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });

    const adapter = new BlueskyTextAdapter({ client: fake });
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
