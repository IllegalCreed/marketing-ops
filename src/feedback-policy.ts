import { createHash } from 'node:crypto';
import type { GitHubIssueInput } from './adapters/github-issue.js';
import type { ChannelId } from './contract.js';
import { MarketingOpsError } from './errors.js';

export interface FeedbackRecord {
  id: string;
  channel: ChannelId;
  body: string;
  sourceUrl: string;
}

export type FeedbackDecision =
  | { decision: 'faq'; intent: 'thanks' | 'documentation'; locale: 'zh-CN' | 'en' }
  | { decision: 'bug'; locale: 'zh-CN' | 'en' }
  | { decision: 'escalate'; reason: string };

const ESCALATION_PATTERN =
  /\b(?:account|credential|delete\s+(?:the\s+)?post|dispute|legal|lawsuit|password|payment|privacy|refund|security|token|vulnerabilit(?:y|ies))\b|投诉|争议|法律|安全|隐私|付款|退款|账号|密码|凭据/i;
const PII_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\+?\d[\s().-]*){8,}\d\b/i;
const INJECTION_PATTERN =
  /\b(?:ignore (?:all |the )?(?:previous |owner |policy|instructions?)|system prompt|developer message|execute (?:a )?tool|call (?:channels_status|publish_campaign|get_publish_status|list_feedback|reply_feedback|delete_post|get_campaign_report))\b|忽略.{0,20}(?:指令|规则|策略)|调用.{0,20}(?:工具|发布|删除|回复)/i;
const EN_BUG_PATTERN =
  /\b(?:bug|broken|crash(?:es|ed)?|does not|doesn't|fails?|incorrect|stays?|wrong|unexpected)\b/i;
const EN_REPRO_PATTERN =
  /\b(?:after|always|enter|every time|happens when|input|reproduc(?:e|es|ible)|steps?|when)\b/i;
const ZH_BUG_PATTERN = /错误|崩溃|失效|无法|没有恢复|结果不对|异常/;
const ZH_REPRO_PATTERN = /每次|输入|步骤|之后|当.+时|可以复现/;

function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p(?:\s[^>]*)?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function localeOf(text: string): 'zh-CN' | 'en' {
  return /[\u3400-\u9fff]/u.test(text) ? 'zh-CN' : 'en';
}

export function classifyFeedback(feedback: FeedbackRecord): FeedbackDecision {
  const text = plainText(feedback.body);
  if (!text || text.length > 2_000) return { decision: 'escalate', reason: 'invalid-length' };
  if (ESCALATION_PATTERN.test(text) || PII_PATTERN.test(text) || INJECTION_PATTERN.test(text)) {
    return { decision: 'escalate', reason: 'sensitive-or-owner-review-required' };
  }
  const locale = localeOf(text);
  if (
    (locale === 'en' && EN_BUG_PATTERN.test(text) && EN_REPRO_PATTERN.test(text)) ||
    (locale === 'zh-CN' && ZH_BUG_PATTERN.test(text) && ZH_REPRO_PATTERN.test(text))
  ) {
    return { decision: 'bug', locale };
  }
  if (
    (locale === 'en' && text.length <= 120 && /^(?:thanks?|thank you)(?:[,.! ]|$)/i.test(text)) ||
    (locale === 'zh-CN' && text.length <= 60 && /^(?:谢谢|感谢)/.test(text))
  ) {
    return { decision: 'faq', intent: 'thanks', locale };
  }
  if (
    (locale === 'en' &&
      /(?:where|how).*(?:documentation|docs|guide|use)|(?:documentation|docs).*(?:where|how)/i.test(
        text,
      ) &&
      /[?？]$/.test(text)) ||
    (locale === 'zh-CN' && /(?:文档|使用说明|指南).*(?:哪里|在哪|怎么|如何).*[?？]?$/.test(text))
  ) {
    return { decision: 'faq', intent: 'documentation', locale };
  }
  return { decision: 'escalate', reason: 'classification-not-high-confidence' };
}

export function buildFaqReply(
  decision: Extract<FeedbackDecision, { decision: 'faq' }>,
  canonicalOrigin: string,
): string {
  const origin = new URL(canonicalOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new MarketingOpsError('INVALID_INPUT', 'Project canonical origin is invalid');
  }
  if (decision.intent === 'thanks') {
    return decision.locale === 'zh-CN' ? '感谢反馈。' : 'Thanks for the feedback.';
  }
  return decision.locale === 'zh-CN'
    ? `项目文档：${origin.href}`
    : `Project documentation: ${origin.href}`;
}

export function buildBugIssue(input: {
  projectId: string;
  campaignId: string;
  feedback: FeedbackRecord;
  idempotencyKey: string;
}): GitHubIssueInput {
  const classification = classifyFeedback(input.feedback);
  if (classification.decision !== 'bug') {
    throw new MarketingOpsError('INVALID_INPUT', 'Feedback is not an approved bug candidate');
  }
  return {
    projectId: input.projectId,
    campaignId: input.campaignId,
    idempotencyKey: input.idempotencyKey,
    title: `Feedback triage: possible bug in ${input.campaignId}`,
    body: [
      'A public feedback item matched the fail-closed actionable bug policy.',
      '',
      `- Project: ${input.projectId}`,
      `- Campaign: ${input.campaignId}`,
      `- Channel: ${input.feedback.channel}`,
      `- Feedback ID SHA-256: ${createHash('sha256').update(input.feedback.id).digest('hex')}`,
      '',
      'The untrusted comment body and author identity were not copied. Verify the source before implementation.',
    ].join('\n'),
    sourceUrls: [input.feedback.sourceUrl],
  };
}
