import { describe, expect, it, vi } from 'vitest';
import { AdapterError, AdapterTransportError } from './adapters/contract.js';
import {
  DevCollector,
  type DevCommentRecord,
  type DevObservabilityClient,
} from './dev-observability.js';
import type { PublishReceipt, PublicPostRef } from './receipt-store.js';

const PUBLIC_URL = 'https://dev.to/algorithmviz/quick-sort-visualized-1234';

function article() {
  return {
    id: 321,
    title: 'Quick Sort, visualized step by step',
    bodyMarkdown: 'Body',
    canonicalUrl: 'https://algo.illegalscreed.cn/en/docs/quick-sort/',
    publicUrl: PUBLIC_URL,
    publishedAt: '2026-07-15T01:00:00.000Z',
    commentsCount: 2,
    publicReactionsCount: 5,
    positiveReactionsCount: 4,
  };
}

function client(): DevObservabilityClient {
  return {
    getArticle: vi.fn(async () => article()),
    listComments: vi.fn(async () => [
      {
        id: 'root1',
        bodyHtml: '<p>Root feedback</p>',
        createdAt: '2026-07-15T02:00:00.000Z',
        authorAlias: 'reader_one',
        children: [
          {
            id: 'child1',
            bodyHtml: '<p>Nested feedback</p>',
            createdAt: '2026-07-15T02:05:00.000Z',
            authorAlias: 'reader_two',
            children: [],
          },
        ],
      },
    ]),
  };
}

function receipt(): PublishReceipt {
  return {
    schemaVersion: 1,
    campaignId: 'quick-sort-launch',
    channel: 'dev',
    postId: '321',
    publicUrl: PUBLIC_URL,
    publishedAt: '2026-07-15T01:00:00.000Z',
    contentHash: 'd'.repeat(64),
    idempotencyKey: 'campaign-v2/quick-sort-launch/dev-1234',
    adapterVersion: 'dev-article@0.1.0',
    status: 'published',
  };
}

function postRef(): PublicPostRef {
  return { channel: 'dev', postId: '321', publicUrl: PUBLIC_URL };
}

describe('DEV observability collector', () => {
  it('TC-AUTO-DEVOBS-127-01 报告只归属文章公开反应/评论并声明无 page views', async () => {
    const fake = client();
    const collector = new DevCollector({
      client: fake,
      now: () => '2026-07-15T03:00:00.000Z',
    });

    await expect(collector.collect(receipt())).resolves.toEqual({
      schemaVersion: 1,
      channel: 'dev',
      scope: 'article-lifetime',
      attribution: 'post-level',
      collectedAt: '2026-07-15T03:00:00.000Z',
      article: {
        postId: '321',
        publicUrl: PUBLIC_URL,
        publishedAt: '2026-07-15T01:00:00.000Z',
        comments: 2,
        reactions: { public: 5, positive: 4 },
        pageViews: { status: 'unavailable', reason: 'not-in-stable-article-response' },
      },
      limitations: ['article-counts-are-lifetime-totals', 'page-views-not-collected'],
    });
  });

  it('TC-AUTO-DEVOBS-127-02 评论树展平、分页并全部标为 untrusted', async () => {
    const fake = client();
    const collector = new DevCollector({ client: fake });
    const first = await collector.listFeedback(postRef());

    expect(first.items).toHaveLength(2);
    expect(first.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'dev-comment:root1',
          body: '<p>Root feedback</p>',
          untrusted: true,
        }),
        expect.objectContaining({
          id: 'dev-comment:child1',
          body: '<p>Nested feedback</p>',
          untrusted: true,
        }),
      ]),
    );
    expect(first.nextCursor).toBeNull();
    expect(first.truncated).toBe(false);
    expect(fake.listComments).toHaveBeenCalledWith(321, 1);
  });

  it('TC-AUTO-DEVOBS-127-03 满页生成有界 cursor，非法 cursor 拒绝', async () => {
    const fake = client();
    vi.mocked(fake.listComments).mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, index) => ({
        id: `c${index}`,
        bodyHtml: '<p>Feedback</p>',
        createdAt: '2026-07-15T02:00:00.000Z',
        authorAlias: 'reader',
        children: [],
      })),
    );
    const collector = new DevCollector({ client: fake });
    const first = await collector.listFeedback(postRef());

    expect(first.nextCursor).toBeTypeOf('string');
    await collector.listFeedback(postRef(), first.nextCursor ?? undefined);
    expect(fake.listComments).toHaveBeenLastCalledWith(321, 2);
    await expect(collector.listFeedback(postRef(), 'not-a-cursor')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    const tenthPage = Buffer.from(
      JSON.stringify({ v: 1, channel: 'dev', page: 10 }),
      'utf8',
    ).toString('base64url');
    vi.mocked(fake.listComments).mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, index) => ({
        id: `last${index}`,
        bodyHtml: '<p>Feedback</p>',
        createdAt: '2026-07-15T02:00:00.000Z',
        authorAlias: 'reader',
        children: [],
      })),
    );
    await expect(collector.listFeedback(postRef(), tenthPage)).resolves.toMatchObject({
      nextCursor: null,
      truncated: true,
    });
  });

  it('TC-AUTO-DEVOBS-127-04 只接受已知 DEV ID/URL 对且远端必须一致', async () => {
    const fake = client();
    const collector = new DevCollector({ client: fake });
    for (const invalid of [
      { ...postRef(), channel: 'github' as const },
      { ...postRef(), postId: 'not-a-number' },
      { ...postRef(), postId: '999999999999999999999' },
      { ...postRef(), publicUrl: 'https://example.com/article' },
    ]) {
      await expect(collector.listFeedback(invalid)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }

    vi.mocked(fake.getArticle).mockResolvedValueOnce({
      ...article(),
      publicUrl: `${PUBLIC_URL}-other`,
    });
    await expect(collector.collect(receipt())).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' });

    await expect(collector.collect({ ...receipt(), status: 'deleted' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('TC-AUTO-DEVOBS-127-05 平台错误与超深评论树失败关闭', async () => {
    const adapterFailure = client();
    vi.mocked(adapterFailure.getArticle).mockRejectedValueOnce(
      new AdapterError('TEMPORARY_FAILURE', 'safe', { retryable: true }),
    );
    await expect(
      new DevCollector({ client: adapterFailure }).collect(receipt()),
    ).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
    });

    const transportFailure = client();
    vi.mocked(transportFailure.listComments).mockRejectedValueOnce(
      new AdapterTransportError('private', { status: 503, stage: 'before-submit' }),
    );
    await expect(
      new DevCollector({ client: transportFailure }).listFeedback(postRef()),
    ).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE' });

    const deep = client();
    let nested: DevCommentRecord = {
      id: 'leaf',
      bodyHtml: '<p>Deep</p>',
      createdAt: '2026-07-15T02:00:00.000Z',
      authorAlias: 'reader',
      children: [],
    };
    for (let depth = 0; depth < 21; depth += 1) {
      nested = { ...nested, id: `depth${depth}`, children: [nested] };
    }
    vi.mocked(deep.listComments).mockResolvedValueOnce([nested]);
    await expect(new DevCollector({ client: deep }).listFeedback(postRef())).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
    });
  });
});
