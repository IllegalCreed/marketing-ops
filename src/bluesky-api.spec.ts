import { describe, expect, it, vi } from 'vitest';
import {
  BlueskyApiClient,
  normalizeBlueskyCredentials,
  type BlueskySdkClient,
} from './adapters/bluesky-api.js';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const HANDLE = 'algorithms-visualization.bsky.social';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const URI = `at://${DID}/app.bsky.feed.post/3ltx4abcde22a`;

function sdk() {
  return {
    login: vi.fn<BlueskySdkClient['login']>().mockResolvedValue({
      data: { did: DID, handle: HANDLE },
    }),
    getProfile: vi.fn<BlueskySdkClient['getProfile']>().mockResolvedValue({
      data: { did: DID, handle: HANDLE },
    }),
    getAuthorFeed: vi.fn<BlueskySdkClient['getAuthorFeed']>().mockResolvedValue({
      data: { feed: [] },
    }),
    post: vi.fn<BlueskySdkClient['post']>().mockResolvedValue({ uri: URI, cid: 'bafy-post' }),
    deletePost: vi.fn().mockResolvedValue(undefined),
  };
}

function client(fake = sdk()) {
  return {
    fake,
    client: new BlueskyApiClient({
      credentials: { handle: `@${HANDLE.toUpperCase()}`, appPassword: APP_PASSWORD },
      sdkFactory: () => fake,
      now: () => '2026-07-14T09:00:00.000Z',
    }),
  };
}

function feedPost(text: string) {
  return {
    post: {
      uri: URI,
      cid: 'bafy-post',
      author: { did: DID, handle: HANDLE, displayName: 'Algorithm Visualizer' },
      record: {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: '2026-07-14T08:00:00.000Z',
      },
    },
  };
}

describe('Bluesky official SDK client boundary', () => {
  it('TC-AUTO-BSKYAPI-127-00 默认工厂只构造固定官方服务客户端', () => {
    expect(
      new BlueskyApiClient({
        credentials: { handle: HANDLE, appPassword: APP_PASSWORD },
      }),
    ).toBeInstanceOf(BlueskyApiClient);
  });

  it('TC-AUTO-BSKYAPI-127-01 handle 与专用 App Password 输入严格规范化', () => {
    expect(
      normalizeBlueskyCredentials({
        handle: ` @${HANDLE.toUpperCase()} `,
        appPassword: APP_PASSWORD,
      }),
    ).toEqual({ handle: HANDLE, appPassword: APP_PASSWORD });

    for (const value of [
      { handle: 'not-a-handle', appPassword: APP_PASSWORD },
      { handle: HANDLE, appPassword: 'short' },
      { handle: HANDLE, appPassword: 'primary password with spaces' },
    ]) {
      expect(() => normalizeBlueskyCredentials(value)).toThrowError(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    }
  });

  it('TC-AUTO-BSKYAPI-127-02 health 只返回公开身份，不泄露 session 或 App Password', async () => {
    const { client: api, fake } = client();

    await expect(api.checkHealth()).resolves.toEqual({
      health: 'ready',
      alias: HANDLE,
      did: DID,
      reason: 'READY',
    });
    expect(fake.login).toHaveBeenCalledWith({ identifier: HANDLE, password: APP_PASSWORD });
    expect(fake.getProfile).toHaveBeenCalledWith({ actor: DID });
    expect(JSON.stringify(await api.checkHealth())).not.toContain(APP_PASSWORD);
    expect(fake.login).toHaveBeenCalledOnce();
  });

  it('TC-AUTO-BSKYAPI-127-03 最近正文查询严格解析自己的 feed', async () => {
    const text = 'Quick Sort is live https://algo.illegalscreed.cn/en/docs/quick-sort/';
    const { client: api, fake } = client();
    fake.getAuthorFeed.mockResolvedValueOnce({
      data: { feed: [feedPost('other'), feedPost(text)], cursor: 'next-page' },
    });

    await expect(api.findRecentPostByText(text)).resolves.toEqual({
      complete: true,
      post: {
        uri: URI,
        cid: 'bafy-post',
        text,
        publicUrl: `https://bsky.app/profile/${DID}/post/3ltx4abcde22a`,
        publishedAt: '2026-07-14T08:00:00.000Z',
      },
    });
    expect(fake.getAuthorFeed).toHaveBeenCalledWith({
      actor: DID,
      filter: 'posts_no_replies',
      limit: 100,
    });

    fake.getAuthorFeed.mockResolvedValueOnce({ data: { feed: [feedPost('other')] } });
    await expect(api.findRecentPostByText(text)).resolves.toEqual({
      complete: true,
      post: null,
    });
  });

  it('TC-AUTO-BSKYAPI-127-04 创建英文正文时生成链接 facet、语言和公开 URL', async () => {
    const text =
      'Quick Sort is live: https://algo.illegalscreed.cn/en/docs/quick-sort/?utm_source=bluesky';
    const { client: api, fake } = client();

    await expect(api.createTextPost({ text, langs: ['en'] })).resolves.toEqual({
      uri: URI,
      cid: 'bafy-post',
      text,
      publicUrl: `https://bsky.app/profile/${DID}/post/3ltx4abcde22a`,
      publishedAt: '2026-07-14T09:00:00.000Z',
    });
    expect(fake.post).toHaveBeenCalledWith({
      text,
      facets: [
        expect.objectContaining({
          features: [
            {
              $type: 'app.bsky.richtext.facet#link',
              uri: 'https://algo.illegalscreed.cn/en/docs/quick-sort/?utm_source=bluesky',
            },
          ],
        }),
      ],
      langs: ['en'],
      createdAt: '2026-07-14T09:00:00.000Z',
    });
  });

  it('TC-AUTO-BSKYAPI-127-04B 未注入时钟时使用有效 UTC 时间', async () => {
    const fake = sdk();
    const api = new BlueskyApiClient({
      credentials: { handle: HANDLE, appPassword: APP_PASSWORD },
      sdkFactory: () => fake,
    });

    const post = await api.createTextPost({ text: 'Quick Sort is live', langs: ['en'] });

    expect(Number.isNaN(Date.parse(post.publishedAt))).toBe(false);
    expect(fake.post).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: post.publishedAt }),
    );
  });

  it('TC-AUTO-BSKYAPI-127-04C 删除只接受当前账号 DID 的合法帖子 URI', async () => {
    const { client: api, fake } = client();

    await expect(api.deleteTextPost(URI)).resolves.toEqual({ status: 'deleted' });
    expect(fake.deletePost).toHaveBeenCalledWith(URI);

    await expect(
      api.deleteTextPost('at://did:plc:zyxwvutsrqponmlkjihgfedc/app.bsky.feed.post/3ltx4abcde22a'),
    ).rejects.toMatchObject({ status: 403, stage: 'before-submit' });
    await expect(api.deleteTextPost('not-an-at-uri')).rejects.toMatchObject({
      status: 403,
      stage: 'before-submit',
    });
    expect(fake.deletePost).toHaveBeenCalledOnce();
  });

  it('TC-AUTO-BSKYAPI-127-05 认证、限流、服务异常与畸形响应失败关闭', async () => {
    for (const status of [401, 403, 429, 503]) {
      const fake = sdk();
      fake.login.mockRejectedValueOnce({ status, message: `private ${APP_PASSWORD}` });
      const api = client(fake).client;
      const health = await api.checkHealth();
      expect(health).toMatchObject({
        health: status === 401 ? 'reauth-required' : 'blocked',
        alias: null,
        did: null,
      });
      expect(JSON.stringify(health)).not.toContain(APP_PASSWORD);
    }

    const malformedLogin = sdk();
    malformedLogin.login.mockResolvedValueOnce({ data: { did: 'bad', handle: HANDLE } });
    await expect(client(malformedLogin).client.checkHealth()).resolves.toMatchObject({
      health: 'blocked',
      reason: 'INVALID_RESPONSE',
    });

    const malformedFeed = sdk();
    malformedFeed.getAuthorFeed.mockResolvedValueOnce({ data: { feed: 'private' } } as never);
    await expect(client(malformedFeed).client.findRecentPostByText('text')).rejects.toMatchObject({
      stage: 'before-submit',
    });

    const malformedPost = sdk();
    malformedPost.post.mockResolvedValueOnce({ uri: 'bad', cid: '' });
    await expect(
      client(malformedPost).client.createTextPost({ text: 'text', langs: ['en'] }),
    ).rejects.toMatchObject({ stage: 'after-submit' });

    const failedDelete = sdk();
    failedDelete.deletePost.mockRejectedValueOnce({ status: 401, message: APP_PASSWORD });
    await expect(client(failedDelete).client.deleteTextPost(URI)).rejects.toMatchObject({
      status: 401,
      stage: 'after-submit',
    });
  });

  it('TC-AUTO-BSKYAPI-127-06 SDK 错误只映射状态与 bounded retry，不回传原始正文', async () => {
    const rate = sdk();
    rate.getAuthorFeed.mockRejectedValueOnce({
      status: 429,
      headers: { 'retry-after': '90' },
      message: `Bearer ${APP_PASSWORD}`,
    });
    await expect(client(rate).client.findRecentPostByText('text')).rejects.toMatchObject({
      status: 429,
      stage: 'before-submit',
      retryAfterSeconds: 90,
    });

    const unknown = sdk();
    unknown.post.mockRejectedValueOnce(new TypeError(`network ${APP_PASSWORD}`));
    const error = await client(unknown)
      .client.createTextPost({ text: 'text', langs: ['en'] })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ timeout: true, stage: 'after-submit' });
    expect(JSON.stringify(error)).not.toContain(APP_PASSWORD);
  });
});
