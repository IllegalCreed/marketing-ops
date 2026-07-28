import { describe, expect, it } from 'vitest';
import { buildFollowUpSchedule, reportWindowState } from './follow-up-schedule.js';
import type { ProjectPublishReceipt } from './receipt-store.js';

function receipt(
  channel: ProjectPublishReceipt['channel'],
  publishedAt: string,
  adapterVersion: string,
  status: ProjectPublishReceipt['status'] = 'published',
): ProjectPublishReceipt {
  return {
    schemaVersion: 2,
    projectId: 'algorithm-visualizer',
    campaignId: 'quick-sort-launch',
    channel,
    postId: `${channel}-1`,
    publicUrl: `https://example.com/${channel}-1`,
    publishedAt,
    contentHash: 'a'.repeat(64),
    idempotencyKey: `campaign-v3/algorithm-visualizer/quick-sort-launch/${channel}/abcdefgh`,
    adapterVersion,
    status,
  };
}

describe('campaign one-time follow-up schedule', () => {
  it('TC-AUTO-SCHEDULE-127-01 以最后主发布为锚点生成稳定三窗口任务', () => {
    const schedule = buildFollowUpSchedule({
      projectId: 'algorithm-visualizer',
      campaignId: 'quick-sort-launch',
      receipts: [
        receipt('github', '2026-07-28T00:00:00.000Z', 'github-release@1.3.0'),
        receipt('mastodon', '2026-07-28T00:05:00.000Z', 'mastodon-status@0.1.0'),
      ],
    });

    expect(schedule).toEqual([
      expect.objectContaining({
        window: '1h',
        anchorAt: '2026-07-28T00:05:00.000Z',
        dueAt: '2026-07-28T01:05:00.000Z',
        taskKey: 'campaign-report/algorithm-visualizer/quick-sort-launch/1h',
        delivery: 'codex-one-time-task',
      }),
      expect.objectContaining({ window: '48h', dueAt: '2026-07-30T00:05:00.000Z' }),
      expect.objectContaining({ window: '7d', dueAt: '2026-08-04T00:05:00.000Z' }),
    ]);
  });

  it('TC-AUTO-SCHEDULE-127-02 artifact 不移动锚点，deleted 主发布仍可恢复计划', () => {
    const values = [
      receipt('dev', '2026-07-28T00:00:00.000Z', 'dev-article@0.2.0', 'deleted'),
      receipt('github', '2026-07-29T00:00:00.000Z', 'github-issue@1.1.0'),
      receipt('github', '2026-07-30T00:00:00.000Z', 'github-issue-reply@1.0.0'),
    ];
    expect(
      buildFollowUpSchedule({
        projectId: 'algorithm-visualizer',
        campaignId: 'quick-sort-launch',
        receipts: values,
      })[0],
    ).toMatchObject({ anchorAt: '2026-07-28T00:00:00.000Z' });

    expect(
      buildFollowUpSchedule({
        projectId: 'algorithm-visualizer',
        campaignId: 'missing',
        receipts: [receipt('github', '2026-07-28T00:00:00.000Z', 'github-release@1.3.0', 'failed')],
      }),
    ).toEqual([]);
  });

  it('TC-AUTO-SCHEDULE-127-04 到期前 scheduled，到点后 due', () => {
    const [task] = buildFollowUpSchedule({
      projectId: 'algorithm-visualizer',
      campaignId: 'quick-sort-launch',
      receipts: [receipt('github', '2026-07-28T00:00:00.000Z', 'github-release@1.3.0')],
    });
    if (!task) throw new Error('Expected a follow-up task');

    expect(reportWindowState(task, '2026-07-28T00:59:59.999Z')).toBe('scheduled');
    expect(reportWindowState(task, '2026-07-28T01:00:00.000Z')).toBe('due');
  });
});
