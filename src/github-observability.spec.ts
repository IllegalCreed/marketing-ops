import { describe, expect, it, vi } from 'vitest';
import { AdapterTransportError } from './adapters/contract.js';
import { GitHubCollector, type GitHubObservabilityClient } from './github-observability.js';
import type { PublishReceipt } from './receipt-store.js';

const REPOSITORY = 'IllegalCreed/algorithms-visualization';
const RELEASE_URL =
  'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Fquick-sort-launch';

function receipt(): PublishReceipt {
  return {
    schemaVersion: 1,
    campaignId: 'quick-sort-launch',
    channel: 'github',
    postId: '7',
    publicUrl: RELEASE_URL,
    publishedAt: '2026-07-11T00:00:00.000Z',
    contentHash: 'a'.repeat(64),
    idempotencyKey: 'campaign-v2/quick-sort-launch/github/abc12345',
    adapterVersion: 'github-release@1.0.0',
    status: 'published',
  };
}

function client(): GitHubObservabilityClient {
  return {
    getRelease: vi.fn(async () => ({
      id: 7,
      tagName: 'marketing/quick-sort-launch',
      name: 'Quick Sort',
      body: '<!-- marker -->',
      htmlUrl: RELEASE_URL,
      publishedAt: '2026-07-11T00:00:00Z',
      assets: [{ id: 9, name: 'demo.gif', downloadCount: 3 }],
    })),
    listReleaseReactions: vi.fn(async () => [
      {
        id: 11,
        content: 'rocket' as const,
        userLogin: 'reader',
        createdAt: '2026-07-11T01:00:00Z',
      },
    ]),
    getTrafficViews: vi.fn(async () => ({
      count: 4,
      uniques: 3,
      points: [{ timestamp: '2026-07-11T00:00:00Z', count: 4, uniques: 3 }],
    })),
    getTrafficClones: vi.fn(async () => ({
      count: 2,
      uniques: 2,
      points: [{ timestamp: '2026-07-11T00:00:00Z', count: 2, uniques: 2 }],
    })),
    getTrafficReferrers: vi.fn(async () => [{ referrer: 'Google', count: 3, uniques: 2 }]),
    getTrafficPaths: vi.fn(async () => [
      {
        path: '/IllegalCreed/algorithms-visualization',
        title: 'Algorithm Visualizer',
        count: 3,
        uniques: 2,
      },
    ]),
    listIssueComments: vi.fn(async () => [
      {
        id: 21,
        htmlUrl:
          'https://github.com/IllegalCreed/algorithms-visualization/issues/12#issuecomment-21',
        body: 'The reset button is confusing.',
        userLogin: 'reader',
        createdAt: '2026-07-11T02:00:00Z',
        updatedAt: '2026-07-11T02:00:00Z',
      },
    ]),
  };
}

describe('GitHub campaign observability', () => {
  it('TC-AUTO-GHOBS-127-06 / GHOPS-03 报告区分 Release 指标与不可归因仓库 traffic', async () => {
    const collector = new GitHubCollector({
      client: client(),
      repository: REPOSITORY,
      now: () => '2026-07-11T03:00:00.000Z',
    });

    await expect(collector.collect(receipt())).resolves.toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        channel: 'github',
        scope: 'repository-14d',
        attribution: 'not-attributable-to-campaign',
        release: expect.objectContaining({
          postId: '7',
          assetDownloads: 3,
          reactions: { total: 1, byType: { rocket: 1 } },
        }),
        repositoryTraffic: expect.objectContaining({
          views: expect.objectContaining({ status: 'available', count: 4 }),
          clones: expect.objectContaining({ status: 'available', count: 2 }),
        }),
        limitations: expect.arrayContaining([
          'repository-traffic-is-not-attributable-to-this-campaign',
          'release-feedback-is-reactions-only',
        ]),
      }),
    );
  });

  it('TC-AUTO-GHOBS-127-05 traffic 403 标记不可观测而不伪造零', async () => {
    const blocked = client();
    blocked.getTrafficViews = vi.fn(async () => {
      throw new AdapterTransportError('Bearer private-token', {
        status: 403,
        stage: 'before-submit',
      });
    });
    const collector = new GitHubCollector({ client: blocked, repository: REPOSITORY });
    const report = await collector.collect(receipt());

    expect(report.repositoryTraffic.views).toEqual({
      status: 'unavailable',
      reason: 'permission-denied',
    });
    expect(JSON.stringify(report)).not.toContain('private-token');
  });

  it('TC-AUTO-GHOBS-127-03 / GHOPS-02 Release reactions 与 Issue comments 分页返回 untrusted feedback', async () => {
    const source = client();
    const reactions = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      content: 'eyes' as const,
      userLogin: index === 0 ? null : `reader-${index}`,
      createdAt: '2026-07-11T01:00:00Z',
    }));
    source.listReleaseReactions = vi.fn(async () => reactions);
    const collector = new GitHubCollector({ client: source, repository: REPOSITORY });

    const releaseFeedback = await collector.listFeedback({
      channel: 'github',
      postId: '7',
      publicUrl: RELEASE_URL,
    });
    expect(releaseFeedback.items).toHaveLength(100);
    expect(releaseFeedback.items[0]).toMatchObject({
      id: 'reaction:1',
      kind: 'reaction',
      authorAlias: null,
      body: 'reaction:eyes',
      untrusted: true,
    });
    expect(releaseFeedback.nextCursor).toEqual(expect.any(String));

    await expect(
      collector.listFeedback({
        channel: 'github',
        postId: '12',
        publicUrl: 'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: 'issue-comment:21',
          kind: 'comment',
          body: 'The reset button is confusing.',
          untrusted: true,
        }),
      ],
      nextCursor: null,
    });

    await expect(
      collector.listFeedback(
        { channel: 'github', postId: '7', publicUrl: RELEASE_URL },
        'not-a-valid-cursor',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('TC-AUTO-GHOBS-127-03 feedback cursor 有界、区分类型并在第十页截断', async () => {
    const source = client();
    const reaction = {
      id: 11,
      content: 'rocket' as const,
      userLogin: 'reader',
      createdAt: '2026-07-11T01:00:00Z',
    };
    source.listReleaseReactions = vi.fn(async (_repository, _releaseId, page) =>
      page === 1 ? Array.from({ length: 100 }, (_, index) => ({ ...reaction, id: index + 1 })) : [],
    );
    source.listIssueComments = vi.fn(async () =>
      Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        htmlUrl: `https://github.com/${REPOSITORY}/issues/12#issuecomment-${index + 1}`,
        body: `Comment ${index + 1}`,
        userLogin: 'reader',
        createdAt: '2026-07-11T02:00:00Z',
        updatedAt: '2026-07-11T02:00:00Z',
      })),
    );
    const collector = new GitHubCollector({ client: source, repository: REPOSITORY });
    const releaseRef = { channel: 'github' as const, postId: '7', publicUrl: RELEASE_URL };
    const first = await collector.listFeedback(releaseRef);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(
      collector.listFeedback(releaseRef, first.nextCursor ?? undefined),
    ).resolves.toEqual({ items: [], nextCursor: null, truncated: false });

    const issueCursor = Buffer.from(
      JSON.stringify({ v: 1, kind: 'issue-comment', page: 10 }),
      'utf8',
    ).toString('base64url');
    await expect(
      collector.listFeedback(
        {
          channel: 'github',
          postId: '12',
          publicUrl: `https://github.com/${REPOSITORY}/issues/12`,
        },
        issueCursor,
      ),
    ).resolves.toMatchObject({ nextCursor: null, truncated: true });
    await expect(collector.listFeedback(releaseRef, issueCursor)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('TC-AUTO-GHOBS-127-02..03 拒绝错仓库、错引用、错 URL 与非法 ID', async () => {
    expect(() => new GitHubCollector({ client: client(), repository: 'not-a-repository' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    const collector = new GitHubCollector({ client: client(), repository: REPOSITORY });
    await expect(collector.collect({ ...receipt(), status: 'deleted' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(collector.collect({ ...receipt(), postId: '0' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      collector.listFeedback({ channel: 'dev', postId: '7', publicUrl: RELEASE_URL }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      collector.listFeedback({
        channel: 'github',
        postId: '12',
        publicUrl: `https://github.com/${REPOSITORY}/issues/13`,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      collector.listFeedback({
        channel: 'github',
        postId: '12',
        publicUrl: `https://github.com/${REPOSITORY}/discussions/12`,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      collector.listFeedback({
        channel: 'github',
        postId: '9'.repeat(400),
        publicUrl: RELEASE_URL,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('TC-AUTO-GHOBS-127-03..06 对拍 Release、限制 reaction 窗口并保护指标整数边界', async () => {
    const mismatch = client();
    mismatch.getRelease = vi.fn(async () => ({
      ...(await client().getRelease(REPOSITORY, 7)),
      id: 8,
    }));
    await expect(
      new GitHubCollector({ client: mismatch, repository: REPOSITORY }).collect(receipt()),
    ).rejects.toMatchObject({ code: 'UNKNOWN_RESULT', lookupRequired: true });

    const overflowing = client();
    overflowing.getRelease = vi.fn(async () => ({
      ...(await client().getRelease(REPOSITORY, 7)),
      assets: [
        { id: 1, name: 'a', downloadCount: Number.MAX_SAFE_INTEGER },
        { id: 2, name: 'b', downloadCount: 1 },
      ],
    }));
    await expect(
      new GitHubCollector({ client: overflowing, repository: REPOSITORY }).collect(receipt()),
    ).rejects.toMatchObject({ code: 'TEMPORARY_FAILURE' });

    const full = client();
    full.listReleaseReactions = vi.fn(async () =>
      Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        content: 'heart' as const,
        userLogin: null,
        createdAt: '2026-07-11T01:00:00Z',
      })),
    );
    const report = await new GitHubCollector({ client: full, repository: REPOSITORY }).collect(
      receipt(),
    );
    expect(report.release.reactions).toEqual({ total: 1_000, byType: { heart: 1_000 } });
    expect(report.release.reactionsTruncated).toBe(true);
    expect(full.listReleaseReactions).toHaveBeenCalledTimes(10);
  });

  it('TC-AUTO-GHOBS-127-05 映射读取错误、脱敏并分别处理 record/items traffic', async () => {
    const blocked = client();
    blocked.getTrafficReferrers = vi.fn(async () => {
      throw new AdapterTransportError('Bearer private-token', {
        status: 403,
        stage: 'before-submit',
      });
    });
    const report = await new GitHubCollector({ client: blocked, repository: REPOSITORY }).collect(
      receipt(),
    );
    expect(report.repositoryTraffic.referrers).toEqual({
      status: 'unavailable',
      reason: 'permission-denied',
    });

    const unavailable = client();
    unavailable.getTrafficViews = vi.fn(async () => {
      throw new AdapterTransportError('private stderr', {
        status: 503,
        stage: 'before-submit',
      });
    });
    await expect(
      new GitHubCollector({ client: unavailable, repository: REPOSITORY }).collect(receipt()),
    ).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
      message: expect.not.stringContaining('private'),
    });

    const reauth = client();
    reauth.listReleaseReactions = vi.fn(async () => {
      throw new AdapterTransportError('Bearer private-token', {
        status: 401,
        stage: 'before-submit',
      });
    });
    await expect(
      new GitHubCollector({ client: reauth, repository: REPOSITORY }).listFeedback({
        channel: 'github',
        postId: '7',
        publicUrl: RELEASE_URL,
      }),
    ).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
      message: expect.not.stringContaining('token'),
    });
  });
});
