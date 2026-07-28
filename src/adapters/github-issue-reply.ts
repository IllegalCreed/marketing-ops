import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PublishReceipt } from '../receipt-store.js';
import { AdapterError, mapAdapterTransportError } from './contract.js';
import type { GitHubIssueComment } from './github-cli.js';

const MAX_LOOKUP_PAGES = 10;
const PAGE_SIZE = 100;
const ADAPTER_VERSION = 'github-issue-reply@1.0.0';

const inputSchema = z
  .object({
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    campaignId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    issueNumber: z.number().int().positive().safe(),
    issueUrl: z.url().startsWith('https://github.com/'),
    sourceCommentId: z.string().min(1).max(200),
    body: z.string().min(1).max(2_000),
    idempotencyKey: z.string().regex(/^[a-z0-9][a-z0-9._/-]{7,255}$/),
  })
  .strict();

export type GitHubIssueReplyInput = z.infer<typeof inputSchema>;

export interface GitHubIssueReplyClient {
  listIssueComments(
    repository: string,
    issueNumber: number,
    page: number,
  ): Promise<GitHubIssueComment[]>;
  createIssueComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubIssueComment>;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function markerParts(input: GitHubIssueReplyInput) {
  const prefix = `<!-- marketing-ops-reply:v1 project=${input.projectId} campaign=${input.campaignId} source-sha256=${hash(input.sourceCommentId)} idempotency-sha256=${hash(input.idempotencyKey)}`;
  const contentHash = hash(input.body);
  return {
    prefix,
    contentHash,
    marker: `${prefix} content-sha256=${contentHash} -->`,
  };
}

export class GitHubIssueReplyAdapter {
  readonly #client: GitHubIssueReplyClient;
  readonly #repository: string;
  readonly #issueUrlPrefix: string;

  constructor(options: { client: GitHubIssueReplyClient; repository: string }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
      throw new AdapterError('INVALID_CONTENT', 'GitHub repository must be owner/name', {
        retryable: false,
      });
    }
    this.#client = options.client;
    this.#repository = options.repository;
    this.#issueUrlPrefix = `https://github.com/${this.#repository}/issues/`;
  }

  async reply(
    value: unknown,
  ): Promise<{ comment: GitHubIssueComment; receipt: PublishReceipt; reused: boolean }> {
    const input = inputSchema.parse(value);
    if (input.issueUrl !== `${this.#issueUrlPrefix}${input.issueNumber}`) {
      throw new AdapterError('INVALID_CONTENT', 'GitHub Issue URL does not match its number', {
        retryable: false,
      });
    }
    const { prefix, marker, contentHash } = markerParts(input);
    for (let page = 1; page <= MAX_LOOKUP_PAGES; page += 1) {
      let comments: GitHubIssueComment[];
      try {
        comments = await this.#client.listIssueComments(this.#repository, input.issueNumber, page);
      } catch (error) {
        throw mapAdapterTransportError(error);
      }
      const existing = comments.find((comment) => comment.body.includes(prefix));
      if (existing) {
        if (!existing.body.includes(marker)) {
          throw new AdapterError(
            'IDEMPOTENCY_CONFLICT',
            'The reply marker already belongs to different content',
            { retryable: false },
          );
        }
        return this.#result(input, existing, contentHash, true);
      }
      if (comments.length < PAGE_SIZE) {
        return this.#create(input, `${marker}\n\n${input.body}`, marker, contentHash);
      }
    }
    throw new AdapterError(
      'UNKNOWN_RESULT',
      'Reply lookup exceeded its bounded window; manual lookup is required',
      { retryable: false, stage: 'before-submit', lookupRequired: true },
    );
  }

  async #create(input: GitHubIssueReplyInput, body: string, marker: string, contentHash: string) {
    let comment: GitHubIssueComment;
    try {
      comment = await this.#client.createIssueComment(this.#repository, input.issueNumber, body);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    if (
      comment.body !== body ||
      !comment.body.includes(marker) ||
      !comment.htmlUrl.startsWith(`${input.issueUrl}#issuecomment-`)
    ) {
      throw new AdapterError(
        'UNKNOWN_RESULT',
        'GitHub returned an unexpected reply; lookup is required before retry',
        { retryable: false, stage: 'after-submit', lookupRequired: true },
      );
    }
    return this.#result(input, comment, contentHash, false);
  }

  #result(
    input: GitHubIssueReplyInput,
    comment: GitHubIssueComment,
    contentHash: string,
    reused: boolean,
  ) {
    return {
      comment,
      receipt: {
        schemaVersion: 2 as const,
        projectId: input.projectId,
        campaignId: input.campaignId,
        channel: 'github' as const,
        postId: String(comment.id),
        publicUrl: comment.htmlUrl,
        publishedAt: comment.createdAt,
        contentHash,
        idempotencyKey: input.idempotencyKey,
        adapterVersion: ADAPTER_VERSION,
        status: 'published' as const,
      },
      reused,
    };
  }
}
