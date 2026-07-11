import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PublishReceipt } from '../receipt-store.js';
import { AdapterError, mapAdapterTransportError } from './contract.js';
import type { GitHubIssueDraft, GitHubIssueRecord } from './github-cli.js';

const MAX_LOOKUP_PAGES = 10;
const PAGE_SIZE = 100;
const ADAPTER_VERSION = 'github-issue@1.0.0';

const issueInputSchema = z
  .object({
    campaignId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    idempotencyKey: z.string().regex(/^[a-z0-9][a-z0-9._/-]{7,255}$/),
    title: z.string().min(1).max(256),
    body: z.string().min(1).max(80_000),
    sourceUrls: z.array(z.url().startsWith('https://')).min(1).max(10),
  })
  .strict();

export type GitHubIssueInput = z.infer<typeof issueInputSchema>;

export interface GitHubIssueClient {
  listIssues(repository: string, page: number): Promise<GitHubIssueRecord[]>;
  createIssue(repository: string, issue: GitHubIssueDraft): Promise<GitHubIssueRecord>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedInput(value: unknown): GitHubIssueInput {
  const input = issueInputSchema.parse(value);
  return { ...input, sourceUrls: [...new Set(input.sourceUrls)].sort() };
}

function markerParts(input: GitHubIssueInput) {
  const idempotencyHash = sha256(input.idempotencyKey);
  const contentHash = sha256(
    JSON.stringify({ title: input.title, body: input.body, sourceUrls: input.sourceUrls }),
  );
  const prefix = `<!-- marketing-ops-issue:v1 campaign=${input.campaignId} idempotency-sha256=${idempotencyHash}`;
  return {
    prefix,
    contentHash,
    marker: `${prefix} content-sha256=${contentHash} -->`,
  };
}

export function buildGitHubIssueDraft(value: unknown): GitHubIssueDraft {
  const input = normalizedInput(value);
  const { marker } = markerParts(input);
  const sources = input.sourceUrls.map((url) => `- ${url}`).join('\n');
  return {
    title: input.title,
    body: `${marker}\n\n${input.body}\n\n## Sources\n\n${sources}`,
  };
}

interface GitHubIssueAdapterOptions {
  client: GitHubIssueClient;
  repository: string;
}

export class GitHubIssueAdapter {
  readonly capabilities = Object.freeze({ create: true, comments: true, reply: false });
  readonly #client: GitHubIssueClient;
  readonly #repository: string;
  readonly #issueUrlPrefix: string;

  constructor(options: GitHubIssueAdapterOptions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
      throw new AdapterError('INVALID_CONTENT', 'GitHub repository must be owner/name', {
        retryable: false,
      });
    }
    this.#client = options.client;
    this.#repository = options.repository;
    this.#issueUrlPrefix = `https://github.com/${this.#repository}/issues/`;
  }

  async create(
    value: unknown,
  ): Promise<{ issue: GitHubIssueRecord; receipt: PublishReceipt; reused: boolean }> {
    const input = normalizedInput(value);
    const draft = buildGitHubIssueDraft(input);
    const { prefix, marker, contentHash } = markerParts(input);

    for (let page = 1; page <= MAX_LOOKUP_PAGES; page += 1) {
      let issues: GitHubIssueRecord[];
      try {
        issues = await this.#client.listIssues(this.#repository, page);
      } catch (error) {
        throw mapAdapterTransportError(error);
      }
      const existing = issues.find((issue) => issue.body.includes(prefix));
      if (existing) {
        if (!existing.body.includes(marker)) {
          throw new AdapterError(
            'IDEMPOTENCY_CONFLICT',
            'The Issue marker already belongs to different content',
            { retryable: false },
          );
        }
        return this.#result(input, existing, contentHash, true);
      }
      if (issues.length < PAGE_SIZE) return this.#create(input, draft, marker, contentHash);
    }

    throw new AdapterError(
      'UNKNOWN_RESULT',
      'Issue lookup exceeded its bounded window; manual lookup is required',
      { retryable: false, stage: 'before-submit', lookupRequired: true },
    );
  }

  async #create(
    input: GitHubIssueInput,
    draft: GitHubIssueDraft,
    marker: string,
    contentHash: string,
  ) {
    let created: GitHubIssueRecord;
    try {
      created = await this.#client.createIssue(this.#repository, draft);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    if (
      created.title !== draft.title ||
      !created.body.includes(marker) ||
      !created.htmlUrl.startsWith(this.#issueUrlPrefix)
    ) {
      throw new AdapterError(
        'UNKNOWN_RESULT',
        'GitHub returned an unexpected Issue; lookup is required before retry',
        { retryable: false, stage: 'after-submit', lookupRequired: true },
      );
    }
    return this.#result(input, created, contentHash, false);
  }

  #result(
    input: GitHubIssueInput,
    issue: GitHubIssueRecord,
    contentHash: string,
    reused: boolean,
  ): { issue: GitHubIssueRecord; receipt: PublishReceipt; reused: boolean } {
    return {
      issue,
      receipt: {
        schemaVersion: 1,
        campaignId: input.campaignId,
        channel: 'github',
        postId: String(issue.number),
        publicUrl: issue.htmlUrl,
        publishedAt: issue.createdAt,
        contentHash,
        idempotencyKey: input.idempotencyKey,
        adapterVersion: ADAPTER_VERSION,
        status: 'published',
      },
      reused,
    };
  }
}
