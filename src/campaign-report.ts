import type { AdapterErrorCode } from './adapters/contract.js';
import {
  isPrimaryPublicationReceipt,
  type CampaignFollowUpTask,
  type ReportWindow,
} from './follow-up-schedule.js';
import type { PublishReceipt } from './receipt-store.js';
import { receiptProjectId } from './receipt-store.js';

type AvailableOutcome = { status: 'available'; observation: unknown };
type UnavailableOutcome = { status: 'unavailable'; reason: string };
type FailedOutcome = {
  status: 'failed';
  code: AdapterErrorCode | 'INVALID_INPUT' | 'STORAGE_CORRUPTED';
  retryable: boolean;
};
export type CollectorOutcome = AvailableOutcome | UnavailableOutcome | FailedOutcome;

interface BuildStandardCampaignReportInput {
  projectId: string;
  campaignId: string;
  window: ReportWindow;
  followUp: CampaignFollowUpTask;
  generatedAt: string;
  receipts: readonly PublishReceipt[];
  outcomes: Record<string, CollectorOutcome>;
}

interface Metric {
  key: string;
  valueStatus: 'available' | 'unavailable';
  value?: number;
  unit: 'count';
  scope: 'post-lifetime' | 'release-lifetime' | 'repository-14d';
  attribution: 'post-level' | 'not-attributable-to-campaign';
  reason?: string;
}

function availableMetric(
  key: string,
  value: number,
  scope: Metric['scope'],
  attribution: Metric['attribution'],
): Metric {
  return { key, valueStatus: 'available', value, unit: 'count', scope, attribution };
}

function unavailableMetric(
  key: string,
  reason: string,
  scope: Metric['scope'],
  attribution: Metric['attribution'],
): Metric {
  return { key, valueStatus: 'unavailable', unit: 'count', scope, attribution, reason };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function countMetric(
  key: string,
  value: unknown,
  scope: Metric['scope'],
  attribution: Metric['attribution'],
): Metric {
  const count = finiteCount(value);
  return count === null
    ? unavailableMetric(key, 'invalid-or-missing-count', scope, attribution)
    : availableMetric(key, count, scope, attribution);
}

function normalizeGitHub(observation: unknown): {
  attribution: 'not-attributable-to-campaign';
  metrics: Metric[];
  limitations: string[];
} {
  const root = record(observation);
  const release = record(root.release);
  const reactions = record(release.reactions);
  const traffic = record(root.repositoryTraffic);
  const views = record(traffic.views);
  const clones = record(traffic.clones);
  const metrics = [
    countMetric('release.reactions', reactions.total, 'release-lifetime', 'post-level'),
    countMetric(
      'release.asset-downloads',
      release.assetDownloads,
      'release-lifetime',
      'post-level',
    ),
  ];
  metrics.push(
    views.status === 'available'
      ? countMetric(
          'repository.views',
          views.count,
          'repository-14d',
          'not-attributable-to-campaign',
        )
      : unavailableMetric(
          'repository.views',
          String(views.reason ?? 'not-collected'),
          'repository-14d',
          'not-attributable-to-campaign',
        ),
    clones.status === 'available'
      ? countMetric(
          'repository.clones',
          clones.count,
          'repository-14d',
          'not-attributable-to-campaign',
        )
      : unavailableMetric(
          'repository.clones',
          String(clones.reason ?? 'not-collected'),
          'repository-14d',
          'not-attributable-to-campaign',
        ),
  );
  return {
    attribution: 'not-attributable-to-campaign',
    metrics,
    limitations: Array.isArray(root.limitations)
      ? root.limitations.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function normalizeDev(observation: unknown): {
  attribution: 'post-level';
  metrics: Metric[];
  limitations: string[];
} {
  const root = record(observation);
  const article = record(root.article);
  const reactions = record(article.reactions);
  const pageViews = record(article.pageViews);
  return {
    attribution: 'post-level',
    metrics: [
      countMetric('article.comments', article.comments, 'post-lifetime', 'post-level'),
      countMetric('article.reactions.public', reactions.public, 'post-lifetime', 'post-level'),
      countMetric('article.reactions.positive', reactions.positive, 'post-lifetime', 'post-level'),
      pageViews.status === 'available'
        ? countMetric('article.page-views', pageViews.count, 'post-lifetime', 'post-level')
        : unavailableMetric(
            'article.page-views',
            String(pageViews.reason ?? 'not-collected'),
            'post-lifetime',
            'post-level',
          ),
    ],
    limitations: Array.isArray(root.limitations)
      ? root.limitations.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function normalizeMastodon(observation: unknown): {
  attribution: 'post-level';
  metrics: Metric[];
  limitations: string[];
} {
  const root = record(observation);
  const status = record(root.status);
  return {
    attribution: 'post-level',
    metrics: [
      countMetric('status.favourites', status.favourites, 'post-lifetime', 'post-level'),
      countMetric('status.reblogs', status.reblogs, 'post-lifetime', 'post-level'),
      countMetric('status.replies', status.replies, 'post-lifetime', 'post-level'),
    ],
    limitations: Array.isArray(root.limitations)
      ? root.limitations.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function normalizedAvailable(receipt: PublishReceipt, observation: unknown) {
  if (receipt.channel === 'github') return normalizeGitHub(observation);
  if (receipt.channel === 'dev') return normalizeDev(observation);
  if (receipt.channel === 'mastodon') return normalizeMastodon(observation);
  return { metrics: [], limitations: ['collector-output-is-not-standardized'] };
}

export function buildStandardCampaignReport(input: BuildStandardCampaignReportInput) {
  const campaignReceipts = input.receipts.filter(
    (receipt) =>
      receiptProjectId(receipt) === input.projectId && receipt.campaignId === input.campaignId,
  );
  const primary = campaignReceipts.filter(isPrimaryPublicationReceipt);
  const artifacts = campaignReceipts
    .filter((receipt) => !isPrimaryPublicationReceipt(receipt))
    .map((receipt) => ({
      channel: receipt.channel,
      postId: receipt.postId,
      publicUrl: receipt.publicUrl,
      adapterVersion: receipt.adapterVersion,
      status: receipt.status,
    }));
  const channels = primary.map((receipt) => {
    const outcome = input.outcomes[receipt.idempotencyKey] ?? {
      status: 'unavailable' as const,
      reason: 'collector-not-implemented',
    };
    const postRef = {
      channel: receipt.channel,
      postId: receipt.postId,
      publicUrl: receipt.publicUrl,
    };
    if (outcome.status === 'failed') {
      return {
        ...postRef,
        adapterVersion: receipt.adapterVersion,
        status: 'failed' as const,
        code: outcome.code,
        retryable: outcome.retryable,
        metrics: [] as Metric[],
        limitations: [] as string[],
      };
    }
    if (outcome.status === 'unavailable') {
      return {
        ...postRef,
        adapterVersion: receipt.adapterVersion,
        status: 'unavailable' as const,
        reason: outcome.reason,
        metrics: [] as Metric[],
        limitations: [] as string[],
      };
    }
    const normalized = normalizedAvailable(receipt, outcome.observation);
    return {
      ...postRef,
      adapterVersion: receipt.adapterVersion,
      status: 'available' as const,
      ...normalized,
    };
  });
  const available = channels.filter((channel) => channel.status === 'available').length;
  const status =
    available === channels.length && channels.length > 0
      ? ('available' as const)
      : available > 0
        ? ('partial' as const)
        : ('unavailable' as const);
  const nextActions = [
    ...(channels.some((channel) => channel.status === 'failed')
      ? ['restore-channel-health-and-rerun-read-only-report' as const]
      : []),
    ...(channels.some((channel) => channel.status === 'unavailable')
      ? ['keep-unavailable-metrics-explicit' as const]
      : []),
    'do-not-infer-site-conversion' as const,
    'owner-review-required-before-new-writes' as const,
  ];
  return {
    schemaVersion: 1 as const,
    projectId: input.projectId,
    campaignId: input.campaignId,
    window: input.window,
    status,
    anchorAt: input.followUp.anchorAt,
    dueAt: input.followUp.dueAt,
    generatedAt: input.generatedAt,
    channels,
    artifacts,
    effort: {
      status: 'unavailable' as const,
      unit: 'minutes' as const,
      reason: 'operator-effort-is-not-recorded-by-receipts',
    },
    nextActions,
    limitations: [
      'channel-metrics-have-different-scopes',
      'site-conversion-is-not-observable-without-a-site-tracker',
      'repository-traffic-is-not-attributable-to-this-campaign',
    ],
  };
}
