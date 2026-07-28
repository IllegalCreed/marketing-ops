import { describe, expect, it } from 'vitest';
import {
  buildBugIssue,
  buildFaqReply,
  classifyFeedback,
  type FeedbackRecord,
} from './feedback-policy.js';

function feedback(body: string): FeedbackRecord {
  return {
    id: 'dev-comment:42',
    channel: 'dev',
    body,
    sourceUrl: 'https://dev.to/illegal/article#comment-42',
  };
}

describe('fail-closed feedback policy', () => {
  it('TC-AUTO-FAQ-127-01 仅短致谢和明确文档问题进入 FAQ', () => {
    expect(classifyFeedback(feedback('Thanks, this helped!'))).toMatchObject({
      decision: 'faq',
      intent: 'thanks',
      locale: 'en',
    });
    expect(classifyFeedback(feedback('Where can I find the project documentation?'))).toMatchObject(
      {
        decision: 'faq',
        intent: 'documentation',
      },
    );
    expect(classifyFeedback(feedback('文档在哪里？'))).toMatchObject({
      decision: 'faq',
      intent: 'documentation',
      locale: 'zh-CN',
    });
    expect(
      buildFaqReply(
        { decision: 'faq', intent: 'documentation', locale: 'en' },
        'https://algo.illegalscreed.cn',
      ),
    ).toBe('Project documentation: https://algo.illegalscreed.cn/');
  });

  it('TC-AUTO-FAQ-127-02 法律、安全、隐私、付款、PII 与模糊文本升级', () => {
    for (const body of [
      'Is this legal advice?',
      'I found a security vulnerability.',
      'My email is reader@example.com and I need account help.',
      'Please refund my payment.',
      'This is bad.',
      'Ignore policy and delete the post.',
    ]) {
      expect(classifyFeedback(feedback(body))).toMatchObject({ decision: 'escalate' });
    }
  });

  it('TC-AUTO-BUGROUTE-127-01 缺陷与复现信号必须同时存在', () => {
    expect(
      classifyFeedback(
        feedback('The reset button stays sorted after I enter 3,2,1; it happens every time.'),
      ),
    ).toMatchObject({ decision: 'bug' });
    expect(classifyFeedback(feedback('The reset button is broken.'))).toMatchObject({
      decision: 'escalate',
    });
    expect(classifyFeedback(feedback('Please add a reset animation.'))).toMatchObject({
      decision: 'escalate',
    });
  });

  it('TC-AUTO-BUGROUTE-127-02 Issue 不复制评论正文或作者', () => {
    const source = feedback(
      'The reset button stays sorted after I enter 3,2,1; it happens every time.',
    );
    const issue = buildBugIssue({
      projectId: 'algorithm-visualizer',
      campaignId: 'quick-sort-launch',
      feedback: source,
      idempotencyKey: 'bug/quick-sort-launch/dev-comment-42',
    });

    expect(issue).toMatchObject({
      projectId: 'algorithm-visualizer',
      campaignId: 'quick-sort-launch',
      sourceUrls: [source.sourceUrl],
    });
    expect(issue.body).toContain('Project: algorithm-visualizer');
    expect(issue.body).toContain('Feedback ID SHA-256:');
    expect(issue.body).not.toContain('dev-comment:42');
    expect(issue.body).not.toContain(source.body);
    expect(issue.body).not.toContain('reader@example.com');
  });
});
