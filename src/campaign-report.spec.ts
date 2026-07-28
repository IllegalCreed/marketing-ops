import { describe, expect, it } from 'vitest';
import { buildStandardCampaignReport } from './campaign-report.js';
import { buildFollowUpSchedule } from './follow-up-schedule.js';
import type { ProjectPublishReceipt } from './receipt-store.js';

function receipt(
  channel: ProjectPublishReceipt['channel'],
  adapterVersion: string,
  suffix: string = channel,
): ProjectPublishReceipt {
  return {
    schemaVersion: 2,
    projectId: 'algorithm-visualizer',
    campaignId: 'quick-sort-launch',
    channel,
    postId: suffix,
    publicUrl: `https://example.com/${suffix}`,
    publishedAt: '2026-07-28T00:00:00.000Z',
    contentHash: 'a'.repeat(64),
    idempotencyKey: `campaign-v3/algorithm-visualizer/quick-sort-launch/${suffix}/abcdefgh`,
    adapterVersion,
    status: 'published',
  };
}

describe('standard cross-channel campaign report', () => {
  const receipts = [
    receipt('github', 'github-release@1.3.0', '1'),
    receipt('dev', 'dev-article@0.2.0', '2'),
    receipt('mastodon', 'mastodon-status@0.1.0', '3'),
    receipt('bluesky', 'bluesky-text@0.2.0', '4'),
    receipt('github', 'github-issue@1.1.0', '12'),
  ];
  const [followUp] = buildFollowUpSchedule({
    projectId: 'algorithm-visualizer',
    campaignId: 'quick-sort-launch',
    receipts,
  }).filter((task) => task.window === '1h');
  if (!followUp) throw new Error('Expected a follow-up task');

  it('TC-AUTO-REPORT-127-01..03 标准化渠道 metric、不可观测项与 artifact', () => {
    const report = buildStandardCampaignReport({
      projectId: 'algorithm-visualizer',
      campaignId: 'quick-sort-launch',
      window: '1h',
      followUp,
      generatedAt: '2026-07-28T01:00:00.000Z',
      receipts,
      outcomes: {
        [receipts[0]!.idempotencyKey]: {
          status: 'available',
          observation: {
            channel: 'github',
            release: {
              assetDownloads: 2,
              reactions: { total: 3 },
            },
            repositoryTraffic: {
              views: { status: 'available', count: 10, uniques: 7 },
              clones: { status: 'available', count: 4, uniques: 2 },
            },
            limitations: ['repository-traffic-is-not-attributable-to-this-campaign'],
          },
        },
        [receipts[1]!.idempotencyKey]: {
          status: 'available',
          observation: {
            channel: 'dev',
            article: {
              comments: 1,
              reactions: { public: 4, positive: 3 },
              pageViews: { status: 'unavailable', reason: 'not-collected' },
            },
            limitations: ['page-views-not-collected'],
          },
        },
        [receipts[2]!.idempotencyKey]: {
          status: 'available',
          observation: {
            channel: 'mastodon',
            status: { favourites: 5, reblogs: 2, replies: 1 },
            limitations: [],
          },
        },
        [receipts[3]!.idempotencyKey]: {
          status: 'unavailable',
          reason: 'collector-not-implemented',
        },
      },
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'partial',
      channels: [
        {
          channel: 'github',
          status: 'available',
          metrics: expect.arrayContaining([
            expect.objectContaining({
              key: 'repository.views',
              value: 10,
              scope: 'repository-14d',
              attribution: 'not-attributable-to-campaign',
            }),
          ]),
        },
        { channel: 'dev', status: 'available' },
        { channel: 'mastodon', status: 'available' },
        { channel: 'bluesky', status: 'unavailable', reason: 'collector-not-implemented' },
      ],
      artifacts: [{ channel: 'github', adapterVersion: 'github-issue@1.1.0' }],
      effort: {
        status: 'unavailable',
        unit: 'minutes',
        reason: 'operator-effort-is-not-recorded-by-receipts',
      },
      nextActions: expect.arrayContaining([
        'keep-unavailable-metrics-explicit',
        'do-not-infer-site-conversion',
        'owner-review-required-before-new-writes',
      ]),
    });
    expect(report.channels).toHaveLength(4);
    expect(JSON.stringify(report)).toContain('"valueStatus":"unavailable"');
  });

  it('TC-AUTO-REPORT-127-04 单渠道失败不吞掉其他结果', () => {
    const report = buildStandardCampaignReport({
      projectId: 'algorithm-visualizer',
      campaignId: 'quick-sort-launch',
      window: '1h',
      followUp,
      generatedAt: '2026-07-28T01:00:00.000Z',
      receipts: receipts.slice(0, 2),
      outcomes: {
        [receipts[0]!.idempotencyKey]: {
          status: 'failed',
          code: 'RATE_LIMITED',
          retryable: true,
        },
        [receipts[1]!.idempotencyKey]: {
          status: 'unavailable',
          reason: 'reauth-required',
        },
      },
    });

    expect(report).toMatchObject({
      status: 'unavailable',
      channels: [
        { status: 'failed', code: 'RATE_LIMITED' },
        { status: 'unavailable', reason: 'reauth-required' },
      ],
      nextActions: expect.arrayContaining(['restore-channel-health-and-rerun-read-only-report']),
    });
  });

  it('TC-AUTO-REPORT-127-01 缺失或畸形计数显式 unavailable，不伪造 0', () => {
    const report = buildStandardCampaignReport({
      projectId: 'algorithm-visualizer',
      campaignId: 'quick-sort-launch',
      window: '1h',
      followUp,
      generatedAt: '2026-07-28T01:00:00.000Z',
      receipts: [receipts[1]!],
      outcomes: {
        [receipts[1]!.idempotencyKey]: {
          status: 'available',
          observation: {
            channel: 'dev',
            article: {
              reactions: { public: -1, positive: 'unknown' },
              pageViews: { status: 'unavailable', reason: 'not-collected' },
            },
          },
        },
      },
    });

    expect(report.channels[0]?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'article.comments',
          valueStatus: 'unavailable',
          reason: 'invalid-or-missing-count',
        }),
        expect.objectContaining({
          key: 'article.reactions.public',
          valueStatus: 'unavailable',
          reason: 'invalid-or-missing-count',
        }),
      ]),
    );
    expect(report.channels[0]?.metrics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'article.comments', value: 0 })]),
    );
  });
});
