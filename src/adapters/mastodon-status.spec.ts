import { describe, expect, it, vi } from 'vitest';
import { AdapterTransportError } from './contract.js';
import { MastodonStatusAdapter, type MastodonStatusClient } from './mastodon-status.js';
import {
  createAdapterPublishInput,
  createMastodonPackage,
  TEST_CONTENT_HASH,
} from '../test-fixtures.js';

function input() {
  return {
    campaignId: 'quick-sort-launch',
    idempotencyKey: 'campaign-v2/quick-sort-launch/mastodon/abc12345',
    contentHash: TEST_CONTENT_HASH,
    package: createMastodonPackage(),
  };
}

function client(): MastodonStatusClient {
  return {
    findRecentStatusByText: vi.fn(async () => ({ complete: true, status: null })),
    createStatus: vi.fn(async () => ({
      id: '201',
      uri: 'https://mastodon.social/users/illegalcreed/statuses/201',
      text: input().package.variants[0]!.body,
      publicUrl: 'https://mastodon.social/@illegalcreed/201',
      publishedAt: '2026-07-16T01:00:00.000Z',
      replyCount: 0,
      reblogCount: 0,
      favouriteCount: 0,
    })),
    deleteStatus: vi.fn(async () => ({ status: 'deleted' as const })),
  };
}

describe('Mastodon status adapter', () => {
  it('TC-AUTO-MASTOADAPTER-127-01 只接受单语 status 包并复用 renderer 链接', async () => {
    const adapter = new MastodonStatusAdapter({ client: client() });

    await expect(adapter.preflight(input())).resolves.toBeUndefined();
    await expect(
      adapter.preflight({
        ...input(),
        package: {
          ...createMastodonPackage(),
          variants: [
            ...createMastodonPackage().variants,
            {
              locale: 'zh-CN' as const,
              title: '快速排序可视化已上线',
              body: 'bad',
              links: ['https://algo.illegalscreed.cn/docs/quick-sort/'],
              media: [],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });
    await expect(
      adapter.preflight({ ...input(), package: createMastodonPackage(['image']) }),
    ).rejects.toMatchObject({
      code: 'UNRESOLVED_MEDIA',
    });
  });

  it('TC-AUTO-MASTOADAPTER-127-02 查询完整同文状态时幂等复用', async () => {
    const api = client();
    vi.mocked(api.findRecentStatusByText).mockResolvedValueOnce({
      complete: true,
      status: {
        id: '200',
        uri: 'https://mastodon.social/users/illegalcreed/statuses/200',
        text: input().package.variants[0]!.body,
        publicUrl: 'https://mastodon.social/@illegalcreed/200',
        publishedAt: '2026-07-16T00:00:00.000Z',
        replyCount: 0,
        reblogCount: 0,
        favouriteCount: 0,
      },
    });
    const adapter = new MastodonStatusAdapter({ client: api, accountId: '109876' });

    await expect(adapter.publish(input())).resolves.toMatchObject({
      reused: true,
      receipt: { channel: 'mastodon', postId: '200' },
    });
    expect(api.createStatus).not.toHaveBeenCalled();
  });

  it('TC-AUTO-MASTOADAPTER-127-03 创建成功时保留公开 URL 和 adapter version', async () => {
    const adapter = new MastodonStatusAdapter({ client: client(), accountId: '109876' });

    await expect(adapter.publish(input())).resolves.toMatchObject({
      reused: false,
      receipt: {
        channel: 'mastodon',
        postId: '201',
        adapterVersion: 'mastodon-status@0.1.0',
        publicUrl: 'https://mastodon.social/@illegalcreed/201',
      },
    });
  });

  it('TC-AUTO-MASTOADAPTER-127-04 查询不完整、内容冲突与未知结果失败关闭', async () => {
    const incomplete = client();
    vi.mocked(incomplete.findRecentStatusByText).mockResolvedValueOnce({
      complete: false,
      status: null,
    });
    await expect(
      new MastodonStatusAdapter({ client: incomplete, accountId: '109876' }).publish(input()),
    ).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
    });

    const conflict = client();
    vi.mocked(conflict.findRecentStatusByText).mockResolvedValueOnce({
      complete: true,
      status: {
        id: '200',
        uri: 'https://mastodon.social/users/illegalcreed/statuses/200',
        text: 'different body',
        publicUrl: 'https://mastodon.social/@illegalcreed/200',
        publishedAt: '2026-07-16T00:00:00.000Z',
        replyCount: 0,
        reblogCount: 0,
        favouriteCount: 0,
      },
    });
    await expect(
      new MastodonStatusAdapter({ client: conflict, accountId: '109876' }).publish(input()),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    const unknown = client();
    vi.mocked(unknown.createStatus).mockResolvedValueOnce({
      id: '201',
      uri: 'https://mastodon.social/users/illegalcreed/statuses/201',
      text: 'different body',
      publicUrl: 'https://mastodon.social/@illegalcreed/201',
      publishedAt: '2026-07-16T01:00:00.000Z',
      replyCount: 0,
      reblogCount: 0,
      favouriteCount: 0,
    });
    await expect(
      new MastodonStatusAdapter({ client: unknown, accountId: '109876' }).publish(input()),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });
  });

  it('TC-AUTO-MASTOADAPTER-127-05 删除只接受本 adapter 的 published receipt', async () => {
    const api = client();
    const adapter = new MastodonStatusAdapter({ client: api, accountId: '109876' });
    const published = (await adapter.publish(input())).receipt;

    await expect(adapter.delete(published)).resolves.toEqual({ status: 'deleted' });
    expect(api.deleteStatus).toHaveBeenCalledWith('201');
    await expect(
      adapter.delete({ ...published, adapterVersion: 'other@1.0.0' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });
  });

  it('TC-AUTO-MASTOADAPTER-127-06 429 与提交后超时映射共享错误合同', async () => {
    const limited = client();
    vi.mocked(limited.createStatus).mockRejectedValueOnce(
      new AdapterTransportError('limited', {
        status: 429,
        stage: 'before-submit',
        retryAfterSeconds: 33,
      }),
    );
    await expect(
      new MastodonStatusAdapter({ client: limited, accountId: '109876' }).publish(input()),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 33 });

    const timeout = client();
    vi.mocked(timeout.createStatus).mockRejectedValueOnce(
      new AdapterTransportError('timeout', { timeout: true, stage: 'after-submit' }),
    );
    await expect(
      new MastodonStatusAdapter({ client: timeout, accountId: '109876' }).publish(input()),
    ).rejects.toMatchObject({ code: 'UNKNOWN_RESULT', lookupRequired: true });
  });
});
