import { MarketingOpsError } from './errors.js';
import type { PublishReceipt } from './receipt-store.js';
import { receiptProjectId } from './receipt-store.js';

export const REPORT_WINDOWS = ['1h', '48h', '7d'] as const;
export type ReportWindow = (typeof REPORT_WINDOWS)[number];

const WINDOW_MILLISECONDS: Record<ReportWindow, number> = {
  '1h': 60 * 60 * 1_000,
  '48h': 48 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
};

const PRIMARY_ADAPTER_PREFIXES = [
  'github-release@',
  'bluesky-text@',
  'dev-article@',
  'mastodon-status@',
  'weibo-text@',
  'assisted-owner-confirmed@',
] as const;

export interface CampaignFollowUpTask {
  projectId: string;
  campaignId: string;
  window: ReportWindow;
  anchorAt: string;
  dueAt: string;
  taskKey: string;
  delivery: 'codex-one-time-task';
  reportRequest: {
    tool: 'get_campaign_report';
    projectId: string;
    campaignId: string;
    window: ReportWindow;
  };
}

interface BuildFollowUpScheduleInput {
  projectId: string;
  campaignId: string;
  receipts: readonly PublishReceipt[];
}

export function isPrimaryPublicationReceipt(receipt: PublishReceipt): boolean {
  return PRIMARY_ADAPTER_PREFIXES.some((prefix) => receipt.adapterVersion.startsWith(prefix));
}

function scheduleAnchor(input: BuildFollowUpScheduleInput): string | null {
  const candidates = input.receipts.filter(
    (receipt) =>
      receiptProjectId(receipt) === input.projectId &&
      receipt.campaignId === input.campaignId &&
      (receipt.status === 'published' || receipt.status === 'deleted') &&
      isPrimaryPublicationReceipt(receipt),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce(
    (latest, receipt) =>
      Date.parse(receipt.publishedAt) > Date.parse(latest) ? receipt.publishedAt : latest,
    candidates[0]!.publishedAt,
  );
}

export function buildFollowUpSchedule(input: BuildFollowUpScheduleInput): CampaignFollowUpTask[] {
  const anchorAt = scheduleAnchor(input);
  if (!anchorAt) return [];
  const anchor = Date.parse(anchorAt);
  if (!Number.isFinite(anchor)) {
    throw new MarketingOpsError('STORAGE_CORRUPTED', 'Receipt publication time is invalid');
  }
  return REPORT_WINDOWS.map((window) => ({
    projectId: input.projectId,
    campaignId: input.campaignId,
    window,
    anchorAt: new Date(anchor).toISOString(),
    dueAt: new Date(anchor + WINDOW_MILLISECONDS[window]).toISOString(),
    taskKey: `campaign-report/${input.projectId}/${input.campaignId}/${window}`,
    delivery: 'codex-one-time-task',
    reportRequest: {
      tool: 'get_campaign_report',
      projectId: input.projectId,
      campaignId: input.campaignId,
      window,
    },
  }));
}

export function reportWindowState(task: CampaignFollowUpTask, now: string): 'scheduled' | 'due' {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    throw new MarketingOpsError('INVALID_INPUT', 'Report time is invalid');
  }
  return timestamp < Date.parse(task.dueAt) ? 'scheduled' : 'due';
}
