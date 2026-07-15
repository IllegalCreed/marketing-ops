import { describe, expect, it, vi } from 'vitest';
import { DevApiClient, normalizeDevApiKey, type DevFetch } from './adapters/dev-api.js';
import type { DevArticleDraft } from './adapters/dev-article.js';

const API_KEY = 'dev-api-key-abcdefghijklmnop';
const ARTICLE_URL = 'https://dev.to/algorithmviz/quick-sort-visualized-1234';
const CANONICAL_URL = 'https://algo.illegalscreed.cn/en/docs/quick-sort/';
const BODY = '<!-- marketing-ops:v1 content-sha256=abc -->\n\nTrace partitioning step by step.';

const draft: DevArticleDraft = {
  title: 'Quick Sort, visualized step by step',
  bodyMarkdown: BODY,
  canonicalUrl: CANONICAL_URL,
  published: true,
  tags: 'algorithms, webdev, opensource',
};

function article(overrides: Record<string, unknown> = {}) {
  return {
    id: 321,
    title: draft.title,
    body_markdown: draft.bodyMarkdown,
    canonical_url: draft.canonicalUrl,
    url: ARTICLE_URL,
    published_at: '2026-07-15T01:00:00Z',
    comments_count: 2,
    public_reactions_count: 5,
    positive_reactions_count: 4,
    ...overrides,
  };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fetchSequence(...responses: Array<Response | Error>): DevFetch {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch');
    if (response instanceof Error) throw response;
    return response;
  });
}

describe('DEV fixed API client', () => {
  it('TC-AUTO-DEVAPI-127-00 API key 仅接受有界 opaque 值', () => {
    expect(normalizeDevApiKey(API_KEY)).toBe(API_KEY);
    for (const invalid of ['', 'short', 'contains whitespace', 'a'.repeat(257)]) {
      expect(() => normalizeDevApiKey(invalid)).toThrowError(/API key/i);
    }
  });

  it('TC-AUTO-DEVAPI-127-01 健康检查固定 v1 header 且只返回公开身份', async () => {
    const fetcher = fetchSequence(json({ id: 12345, username: 'algorithmviz' }));
    const client = new DevApiClient({ apiKey: API_KEY, fetcher });

    await expect(client.checkHealth()).resolves.toEqual({
      health: 'ready',
      alias: 'algorithmviz',
      userId: 12345,
      reason: 'READY',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://dev.to/api/users/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/vnd.forem.api-v1+json',
          'api-key': API_KEY,
        }),
      }),
    );
    expect(JSON.stringify(await client.checkHealth().catch(() => null))).not.toContain(API_KEY);

    const globalFetch = vi.fn(async () => json({ id: 12345, username: 'algorithmviz' }));
    vi.stubGlobal('fetch', globalFetch);
    try {
      await expect(new DevApiClient({ apiKey: API_KEY }).checkHealth()).resolves.toMatchObject({
        health: 'ready',
      });
      expect(globalFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('TC-AUTO-DEVAPI-127-02 本人文章分页查找完整且命中后读取正文', async () => {
    const fetcher = fetchSequence(json([article({ body_markdown: undefined })]), json(article()));
    const client = new DevApiClient({ apiKey: API_KEY, fetcher });

    await expect(client.findArticle(draft)).resolves.toEqual({
      complete: true,
      article: {
        id: 321,
        title: draft.title,
        bodyMarkdown: draft.bodyMarkdown,
        canonicalUrl: draft.canonicalUrl,
        publicUrl: ARTICLE_URL,
        publishedAt: '2026-07-15T01:00:00.000Z',
        commentsCount: 2,
        publicReactionsCount: 5,
        positiveReactionsCount: 4,
      },
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://dev.to/api/articles/me/all?page=1&per_page=100',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://dev.to/api/articles/321',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('TC-AUTO-DEVAPI-127-03 十页仍满时标记查询不完整并禁止假定不存在', async () => {
    const pages = Array.from({ length: 10 }, (_, page) =>
      json(
        Array.from({ length: 100 }, (_, index) =>
          article({
            id: page * 100 + index + 1,
            title: `Different ${page}-${index}`,
            canonical_url: `https://example.com/${page}/${index}`,
            body_markdown: undefined,
          }),
        ),
      ),
    );
    const client = new DevApiClient({ apiKey: API_KEY, fetcher: fetchSequence(...pages) });

    await expect(client.findArticle(draft)).resolves.toEqual({ complete: false, article: null });

    await expect(
      new DevApiClient({ apiKey: API_KEY, fetcher: fetchSequence(json([])) }).findArticle(draft),
    ).resolves.toEqual({ complete: true, article: null });

    const duplicate = article({ body_markdown: undefined });
    await expect(
      new DevApiClient({
        apiKey: API_KEY,
        fetcher: fetchSequence(json([duplicate, { ...duplicate, id: 322 }])),
      }).findArticle(draft),
    ).rejects.toMatchObject({ stage: 'before-submit' });
  });

  it('TC-AUTO-DEVAPI-127-04 创建只发送固定 article payload 并严格解析回执', async () => {
    const fetcher = fetchSequence(json(article(), 201));
    const client = new DevApiClient({ apiKey: API_KEY, fetcher });

    await expect(client.createArticle(draft)).resolves.toMatchObject({
      id: 321,
      publicUrl: ARTICLE_URL,
      bodyMarkdown: BODY,
    });
    const init = vi.mocked(fetcher).mock.calls[0]?.[1];
    expect(vi.mocked(fetcher).mock.calls[0]?.[0]).toBe('https://dev.to/api/articles');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({
      article: {
        title: draft.title,
        body_markdown: draft.bodyMarkdown,
        canonical_url: draft.canonicalUrl,
        published: true,
        tags: draft.tags,
      },
    });

    await expect(
      new DevApiClient({
        apiKey: API_KEY,
        fetcher: fetchSequence(json({ invalid: true }, 201)),
      }).createArticle(draft),
    ).rejects.toMatchObject({ stage: 'after-submit' });
  });

  it('TC-AUTO-DEVAPI-127-05 评论读取固定分页并保留树结构', async () => {
    const fetcher = fetchSequence(
      json([
        {
          id_code: 'abc123',
          body_html: '<p>Useful walkthrough.</p>',
          created_at: '2026-07-15T02:00:00Z',
          user: { username: 'reader_one' },
          children: [],
        },
      ]),
    );
    const client = new DevApiClient({ apiKey: API_KEY, fetcher });

    await expect(client.listComments(321, 2)).resolves.toEqual([
      {
        id: 'abc123',
        bodyHtml: '<p>Useful walkthrough.</p>',
        createdAt: '2026-07-15T02:00:00.000Z',
        authorAlias: 'reader_one',
        children: [],
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://dev.to/api/comments?a_id=321&page=2&per_page=100',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('TC-AUTO-DEVAPI-127-06 401/429/5xx/畸形与超限响应映射且不泄露 key', async () => {
    for (const [response, reason] of [
      [json({ error: API_KEY }, 401), 'REAUTH_REQUIRED'],
      [json({ error: API_KEY }, 429, { 'retry-after': '120' }), 'RATE_LIMITED'],
      [json({ error: API_KEY }, 503), 'UNAVAILABLE'],
      [json({ id: 'bad', username: API_KEY }), 'INVALID_RESPONSE'],
    ] as const) {
      const health = await new DevApiClient({
        apiKey: API_KEY,
        fetcher: fetchSequence(response),
      }).checkHealth();
      expect(health.reason).toBe(reason);
      expect(JSON.stringify(health)).not.toContain(API_KEY);
    }

    const huge = new Response(`"${'x'.repeat(2_100_000)}"`, { status: 200 });
    await expect(
      new DevApiClient({ apiKey: API_KEY, fetcher: fetchSequence(huge) }).listComments(321, 1),
    ).rejects.toMatchObject({ stage: 'before-submit' });

    const invalidRetry = json({ error: 'rate' }, 429, { 'retry-after': 'later' });
    await expect(
      new DevApiClient({ apiKey: API_KEY, fetcher: fetchSequence(invalidRetry) }).listComments(
        321,
        1,
      ),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: undefined });

    for (const response of [
      new Response(null, { status: 200 }),
      new Response('{broken', { status: 200 }),
      new Response('{}', { status: 200, headers: { 'content-length': '2100000' } }),
    ]) {
      await expect(
        new DevApiClient({ apiKey: API_KEY, fetcher: fetchSequence(response) }).listComments(
          321,
          1,
        ),
      ).rejects.toMatchObject({ stage: 'before-submit' });
    }

    await expect(
      new DevApiClient({ apiKey: API_KEY, fetcher: fetchSequence(json(article())) }).getArticle(0),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      new DevApiClient({
        apiKey: API_KEY,
        fetcher: fetchSequence(json({ invalid: true })),
      }).getArticle(321),
    ).rejects.toMatchObject({ stage: 'before-submit' });
    await expect(
      new DevApiClient({ apiKey: API_KEY, fetcher: fetchSequence(json([])) }).listComments(321, 11),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
