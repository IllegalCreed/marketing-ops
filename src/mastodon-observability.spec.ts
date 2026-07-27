import { describe, expect, it, vi } from 'vitest';
import {
  MastodonCollector,
  type MastodonNotificationRecord,
  type MastodonObservabilityClient,
} from './mastodon-observability.js';

function client(
  notifications: MastodonNotificationRecord[] = [
    {
      id: 'n1',
      type: 'mention',
      createdAt: '2026-07-16T02:00:00.000Z',
      authorAlias: 'reader@example.social',
      statusId: '201',
      statusUrl: 'https://mastodon.social/@illegalcreed/201',
      bodyHtml: '<p>Nice</p>',
    },
  ],
): MastodonObservabilityClient {
  return {
    getStatus: vi.fn(async () => ({
      id: '201',
      uri: 'https://mastodon.social/users/illegalcreed/statuses/201',
      text: 'Hello',
      publicUrl: 'https://mastodon.social/@illegalcreed/201',
      publishedAt: '2026-07-16T01:00:00.000Z',
      replyCount: 1,
      reblogCount: 2,
      favouriteCount: 3,
    })),
    listNotifications: vi.fn(async () => notifications),
  };
}

describe('Mastodon collector', () => {
  it('TC-AUTO-MASTOOBS-127-01 读取状态级指标且不伪造站内归因', async () => {
    const collector = new MastodonCollector({
      client: client(),
      now: () => '2026-07-16T03:00:00.000Z',
    });

    await expect(
      collector.collect({
        schemaVersion: 1,
        campaignId: 'quick-sort-launch',
        channel: 'mastodon',
        postId: '201',
        publicUrl: 'https://mastodon.social/@illegalcreed/201',
        publishedAt: '2026-07-16T01:00:00.000Z',
        contentHash: 'a'.repeat(64),
        idempotencyKey: 'campaign-v2/quick-sort-launch/mastodon/abc12345',
        adapterVersion: 'mastodon-status@0.1.0',
        status: 'published',
      }),
    ).resolves.toMatchObject({
      channel: 'mastodon',
      scope: 'post-lifetime',
      attribution: 'post-level',
      status: {
        favourites: 3,
        reblogs: 2,
        replies: 1,
      },
    });
  });

  it('TC-AUTO-MASTOOBS-127-02 通知只返回与 receipt 匹配的显式不可信反馈', async () => {
    const collector = new MastodonCollector({ client: client() });

    await expect(
      collector.listFeedback({
        channel: 'mastodon',
        postId: '201',
        publicUrl: 'https://mastodon.social/@illegalcreed/201',
      }),
    ).resolves.toEqual({
      items: [
        {
          id: 'mastodon-notification:n1',
          kind: 'mention',
          authorAlias: 'reader@example.social',
          body: '<p>Nice</p>',
          createdAt: '2026-07-16T02:00:00.000Z',
          sourceUrl: 'https://mastodon.social/@illegalcreed/201',
          untrusted: true,
        },
      ],
      nextCursor: null,
      truncated: false,
    });
  });

  it('TC-AUTO-MASTOOBS-127-03 过滤无关通知并校验 postRef', async () => {
    const collector = new MastodonCollector({
      client: client([
        {
          id: 'n1',
          type: 'mention',
          createdAt: '2026-07-16T02:00:00.000Z',
          authorAlias: 'reader@example.social',
          statusId: '999',
          statusUrl: 'https://mastodon.social/@illegalcreed/999',
          bodyHtml: '<p>Elsewhere</p>',
        },
      ]),
    });

    await expect(
      collector.listFeedback({
        channel: 'mastodon',
        postId: '201',
        publicUrl: 'https://mastodon.social/@illegalcreed/201',
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      collector.listFeedback({
        channel: 'github',
        postId: '201',
        publicUrl: 'https://github.com/x',
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
