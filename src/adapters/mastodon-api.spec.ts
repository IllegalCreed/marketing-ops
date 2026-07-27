import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterTransportError } from './contract.js';
import {
  MastodonApiClient,
  normalizeMastodonCredentials,
  type MastodonFetch,
} from './mastodon-api.js';

const ACCESS_TOKEN = 'mastodon-access-token-abcdefghijklmnop';
const INSTANCE_URL = 'https://mastodon.social';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('Mastodon API client', () => {
  it('TC-AUTO-MASTOAPI-127-01 规范化实例 URL 与 access token', () => {
    expect(
      normalizeMastodonCredentials({
        instanceUrl: 'https://mastodon.social/',
        accessToken: ACCESS_TOKEN,
      }),
    ).toEqual({
      instanceUrl: INSTANCE_URL,
      accessToken: ACCESS_TOKEN,
    });

    expect(() =>
      normalizeMastodonCredentials({
        instanceUrl: 'http://mastodon.social',
        accessToken: ACCESS_TOKEN,
      }),
    ).toThrow(/instance/i);
    expect(() =>
      normalizeMastodonCredentials({
        instanceUrl: INSTANCE_URL,
        accessToken: 'short',
      }),
    ).toThrow(/token/i);
  });

  it('TC-AUTO-MASTOAPI-127-02 verify_credentials 健康检查只返回公开身份', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const fetcher: MastodonFetch = async (input, init) => {
      requests.push({ input, init });
      return jsonResponse({
        id: '109876',
        acct: 'illegalcreed@mastodon.social',
        url: 'https://mastodon.social/@illegalcreed',
      });
    };
    const client = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher,
    });

    await expect(client.checkHealth()).resolves.toEqual({
      health: 'ready',
      instanceUrl: INSTANCE_URL,
      alias: 'illegalcreed@mastodon.social',
      accountId: '109876',
      reason: 'READY',
    });
    expect(requests[0]).toMatchObject({
      input: `${INSTANCE_URL}/api/v1/accounts/verify_credentials`,
      init: {
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          Accept: 'application/json',
        }),
      },
    });
  });

  it('TC-AUTO-MASTOAPI-127-03 健康异常映射 reauth、rate-limit 与 invalid-response', async () => {
    const unauthorized = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher: async () => jsonResponse({ error: 'unauthorized' }, { status: 401 }),
    });
    await expect(unauthorized.checkHealth()).resolves.toMatchObject({
      health: 'reauth-required',
      reason: 'REAUTH_REQUIRED',
    });

    const limited = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher: async () =>
        jsonResponse({ error: 'limited' }, { status: 429, headers: { 'retry-after': '17' } }),
    });
    await expect(limited.checkHealth()).resolves.toMatchObject({
      health: 'blocked',
      reason: 'RATE_LIMITED',
    });

    const invalid = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher: async () => jsonResponse({ id: 'broken' }),
    });
    await expect(invalid.checkHealth()).resolves.toMatchObject({
      health: 'blocked',
      reason: 'INVALID_RESPONSE',
    });
  });

  it('TC-AUTO-MASTOAPI-127-04 最近正文查询必须完整且只看本人非回复状态', async () => {
    const fetcher: MastodonFetch = async (input) => {
      expect(input).toContain(
        '/api/v1/accounts/109876/statuses?limit=40&exclude_reblogs=true&exclude_replies=true',
      );
      return jsonResponse([
        {
          id: '200',
          uri: 'https://mastodon.social/users/illegalcreed/statuses/200',
          created_at: '2026-07-16T00:00:00.000Z',
          url: 'https://mastodon.social/@illegalcreed/200',
          content: '<p>Hello</p>',
          text: 'Hello',
          account: { id: '109876', acct: 'illegalcreed@mastodon.social' },
          replies_count: 0,
          reblogs_count: 0,
          favourites_count: 0,
        },
      ]);
    };
    const client = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher,
    });

    await expect(client.findRecentStatusByText('Hello', '109876')).resolves.toEqual({
      complete: true,
      status: {
        id: '200',
        uri: 'https://mastodon.social/users/illegalcreed/statuses/200',
        text: 'Hello',
        publicUrl: 'https://mastodon.social/@illegalcreed/200',
        publishedAt: '2026-07-16T00:00:00.000Z',
        replyCount: 0,
        reblogCount: 0,
        favouriteCount: 0,
      },
    });

    const htmlOnly = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher: async () =>
        jsonResponse([
          {
            id: '200',
            uri: 'https://mastodon.social/users/illegalcreed/statuses/200',
            created_at: '2026-07-16T00:00:00.000Z',
            url: 'https://mastodon.social/@illegalcreed/200',
            content: '<p>Hello &amp; welcome<br>next &lt;step&gt;</p>',
            account: { id: '109876', acct: 'illegalcreed@mastodon.social' },
            replies_count: 0,
            reblogs_count: 0,
            favourites_count: 0,
          },
        ]),
    });
    await expect(
      htmlOnly.findRecentStatusByText('Hello & welcome\nnext <step>', '109876'),
    ).resolves.toMatchObject({ status: { text: 'Hello & welcome\nnext <step>' } });
  });

  it('TC-AUTO-MASTOAPI-127-05 创建状态使用 Idempotency-Key，语言与可见性显式透传', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const fetcher: MastodonFetch = async (input, init) => {
      requests.push({ input, init });
      return jsonResponse({
        id: '201',
        uri: 'https://mastodon.social/users/illegalcreed/statuses/201',
        created_at: '2026-07-16T01:00:00.000Z',
        url: 'https://mastodon.social/@illegalcreed/201',
        content: '<p>Hello</p>',
        text: 'Hello',
        account: { id: '109876', acct: 'illegalcreed@mastodon.social' },
        replies_count: 0,
        reblogs_count: 0,
        favourites_count: 0,
      });
    };
    const client = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher,
    });

    await expect(
      client.createStatus({
        text: 'Hello',
        visibility: 'public',
        language: 'en',
        idempotencyKey: 'campaign-v2/mastodon/hello',
      }),
    ).resolves.toMatchObject({ id: '201', text: 'Hello' });
    expect(requests[0]).toMatchObject({
      input: `${INSTANCE_URL}/api/v1/statuses`,
      init: {
        method: 'POST',
        headers: expect.objectContaining({
          'Idempotency-Key': 'campaign-v2/mastodon/hello',
        }),
        body: expect.any(String),
      },
    });
    expect(String(requests[0]!.init.body)).toContain('language=en');
    expect(String(requests[0]!.init.body)).toContain('visibility=public');
  });

  it('TC-AUTO-MASTOAPI-127-06 通知查询与状态读取都做结构化脱敏', async () => {
    const fetcher: MastodonFetch = async (input) => {
      if (
        input.endsWith(
          '/api/v1/notifications?limit=40&types[]=mention&types[]=favourite&types[]=reblog&types[]=reply',
        )
      ) {
        return jsonResponse([
          {
            id: 'n1',
            type: 'mention',
            created_at: '2026-07-16T02:00:00.000Z',
            account: { acct: 'reader@example.social' },
            status: {
              id: '201',
              url: 'https://mastodon.social/@illegalcreed/201',
              content: '<p>Hi</p>',
            },
          },
        ]);
      }
      return jsonResponse({
        id: '201',
        uri: 'https://mastodon.social/users/illegalcreed/statuses/201',
        created_at: '2026-07-16T01:00:00.000Z',
        url: 'https://mastodon.social/@illegalcreed/201',
        content: '<p>Hello</p>',
        text: 'Hello',
        account: { id: '109876', acct: 'illegalcreed@mastodon.social' },
        replies_count: 1,
        reblogs_count: 2,
        favourites_count: 3,
      });
    };
    const client = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher,
    });

    await expect(client.getStatus('201')).resolves.toMatchObject({
      id: '201',
      replyCount: 1,
      reblogCount: 2,
      favouriteCount: 3,
    });
    await expect(client.listNotifications()).resolves.toEqual([
      {
        id: 'n1',
        type: 'mention',
        createdAt: '2026-07-16T02:00:00.000Z',
        authorAlias: 'reader@example.social',
        statusId: '201',
        statusUrl: 'https://mastodon.social/@illegalcreed/201',
        bodyHtml: '<p>Hi</p>',
      },
    ]);
    await expect(client.deleteStatus('201')).resolves.toEqual({ status: 'deleted' });
    await expect(client.deleteStatus('invalid')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('TC-AUTO-MASTOAPI-127-07 传输错误映射超时与 retry-after', async () => {
    const fetcher: MastodonFetch = async () => {
      throw new Error('offline');
    };
    const client = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher,
    });

    await expect(client.getStatus('201')).rejects.toBeInstanceOf(AdapterTransportError);
    const limited = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher: async () =>
        jsonResponse({ error: 'limited' }, { status: 429, headers: { 'retry-after': '9' } }),
    });
    await expect(limited.getStatus('201')).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 9,
    });

    const malformed = new MastodonApiClient({
      credentials: { instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN },
      fetcher: async () => jsonResponse({ id: 'broken' }),
    });
    await expect(malformed.getStatus('201')).rejects.toBeInstanceOf(AdapterTransportError);

    const defaultFetch = vi.fn(async () =>
      jsonResponse({
        id: '109876',
        acct: 'owner@example.social',
        url: 'https://example.social/@owner',
      }),
    );
    vi.stubGlobal('fetch', defaultFetch);
    await expect(
      new MastodonApiClient({
        credentials: {
          instanceUrl: 'https://example.social',
          accessToken: ACCESS_TOKEN,
        },
      }).checkHealth(),
    ).resolves.toMatchObject({ health: 'ready', alias: 'owner@example.social' });
    expect(defaultFetch).toHaveBeenCalledOnce();
  });
});
