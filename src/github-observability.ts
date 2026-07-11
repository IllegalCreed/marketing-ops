import { z } from 'zod';
import { AdapterError, mapAdapterTransportError } from './adapters/contract.js';
import type {
  GitHubIssueComment,
  GitHubReleaseDetails,
  GitHubReleaseReaction,
  GitHubTrafficPath,
  GitHubTrafficReferrer,
  GitHubTrafficSeries,
} from './adapters/github-cli.js';
import { MarketingOpsError } from './errors.js';
import type { PublicPostRef, PublishReceipt } from './receipt-store.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

export interface GitHubObservabilityClient {
  getRelease(repository: string, releaseId: number): Promise<GitHubReleaseDetails>;
  listReleaseReactions(
    repository: string,
    releaseId: number,
    page: number,
  ): Promise<GitHubReleaseReaction[]>;
  getTrafficViews(repository: string): Promise<GitHubTrafficSeries>;
  getTrafficClones(repository: string): Promise<GitHubTrafficSeries>;
  getTrafficReferrers(repository: string): Promise<GitHubTrafficReferrer[]>;
  getTrafficPaths(repository: string): Promise<GitHubTrafficPath[]>;
  listIssueComments(
    repository: string,
    issueNumber: number,
    page: number,
  ): Promise<GitHubIssueComment[]>;
}

const cursorSchema = z
  .object({
    v: z.literal(1),
    kind: z.enum(['reaction', 'issue-comment']),
    page: z.number().int().min(2).max(MAX_PAGES),
  })
  .strict();

function validateRepository(repository: string): string {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new MarketingOpsError('INVALID_INPUT', 'GitHub repository must be owner/name');
  }
  return repository;
}

function positiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new MarketingOpsError('INVALID_INPUT', `${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MarketingOpsError('INVALID_INPUT', `${label} must be a safe integer`);
  }
  return parsed;
}

function encodeCursor(kind: 'reaction' | 'issue-comment', page: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, page }), 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string | undefined,
  expectedKind: 'reaction' | 'issue-comment',
): number {
  if (cursor === undefined) return 1;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown,
    );
    if (parsed.kind !== expectedKind) throw new Error('cursor kind mismatch');
    return parsed.page;
  } catch {
    throw new MarketingOpsError('INVALID_INPUT', 'Feedback cursor is invalid');
  }
}

function nextCursor(kind: 'reaction' | 'issue-comment', page: number, count: number) {
  return count === PAGE_SIZE && page < MAX_PAGES ? encodeCursor(kind, page + 1) : null;
}

function unavailableTraffic(error: unknown): { status: 'unavailable'; reason: string } | never {
  const mapped = mapAdapterTransportError(error);
  if (mapped.code === 'PERMISSION_DENIED') {
    return { status: 'unavailable', reason: 'permission-denied' };
  }
  throw mapped;
}

async function observeTrafficRecord<T extends object>(read: () => Promise<T>) {
  try {
    return { status: 'available' as const, ...(await read()) };
  } catch (error) {
    return unavailableTraffic(error);
  }
}

async function observeTrafficItems<T>(read: () => Promise<T[]>) {
  try {
    return { status: 'available' as const, items: await read() };
  } catch (error) {
    return unavailableTraffic(error);
  }
}

async function readPlatform<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw mapAdapterTransportError(error);
  }
}

function reactionCounts(reactions: GitHubReleaseReaction[]) {
  const byType: Partial<Record<GitHubReleaseReaction['content'], number>> = {};
  for (const reaction of reactions) byType[reaction.content] = (byType[reaction.content] ?? 0) + 1;
  return { total: reactions.length, byType };
}

function assetDownloads(release: GitHubReleaseDetails): number {
  const total = release.assets.reduce((sum, asset) => sum + asset.downloadCount, 0);
  if (!Number.isSafeInteger(total)) {
    throw new AdapterError('TEMPORARY_FAILURE', 'GitHub asset metrics exceeded safety bounds', {
      retryable: true,
      stage: 'before-submit',
    });
  }
  return total;
}

interface GitHubCollectorOptions {
  client: GitHubObservabilityClient;
  repository: string;
  now?: () => string;
}

export class GitHubCollector {
  readonly #client: GitHubObservabilityClient;
  readonly #repository: string;
  readonly #now: () => string;
  readonly #releaseUrlPrefix: string;
  readonly #issueUrlPrefix: string;

  constructor(options: GitHubCollectorOptions) {
    this.#client = options.client;
    this.#repository = validateRepository(options.repository);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#releaseUrlPrefix = `https://github.com/${this.#repository}/releases/`;
    this.#issueUrlPrefix = `https://github.com/${this.#repository}/issues/`;
  }

  async collect(receipt: PublishReceipt) {
    const releaseId = this.#validateReleaseReceipt(receipt);
    const release = await readPlatform(() => this.#client.getRelease(this.#repository, releaseId));
    if (release.id !== releaseId || release.htmlUrl !== receipt.publicUrl) {
      throw new AdapterError('UNKNOWN_RESULT', 'GitHub release does not match the receipt', {
        retryable: false,
        stage: 'before-submit',
        lookupRequired: true,
      });
    }
    const reactions = await this.#allReactions(releaseId);
    const [views, clones, referrers, paths] = await Promise.all([
      observeTrafficRecord(() => this.#client.getTrafficViews(this.#repository)),
      observeTrafficRecord(() => this.#client.getTrafficClones(this.#repository)),
      observeTrafficItems(() => this.#client.getTrafficReferrers(this.#repository)),
      observeTrafficItems(() => this.#client.getTrafficPaths(this.#repository)),
    ]);

    return {
      schemaVersion: 1 as const,
      channel: 'github' as const,
      scope: 'repository-14d' as const,
      attribution: 'not-attributable-to-campaign' as const,
      collectedAt: this.#now(),
      release: {
        postId: String(release.id),
        publicUrl: release.htmlUrl,
        tagName: release.tagName,
        publishedAt: release.publishedAt,
        assetDownloads: assetDownloads(release),
        reactions: reactionCounts(reactions.items),
        reactionsTruncated: reactions.truncated,
      },
      repositoryTraffic: { views, clones, referrers, paths },
      limitations: [
        'repository-traffic-covers-the-latest-14-days',
        'repository-traffic-is-not-attributable-to-this-campaign',
        'release-feedback-is-reactions-only',
      ],
    };
  }

  async listFeedback(postRef: PublicPostRef, cursor?: string) {
    if (postRef.channel !== 'github') {
      throw new MarketingOpsError('INVALID_INPUT', 'GitHub collector requires a GitHub post');
    }
    if (postRef.publicUrl.startsWith(this.#releaseUrlPrefix)) {
      const releaseId = positiveInteger(postRef.postId, 'Release ID');
      const page = decodeCursor(cursor, 'reaction');
      const reactions = await readPlatform(() =>
        this.#client.listReleaseReactions(this.#repository, releaseId, page),
      );
      return {
        items: reactions.map((reaction) => ({
          id: `reaction:${reaction.id}`,
          kind: 'reaction' as const,
          authorAlias: reaction.userLogin,
          body: `reaction:${reaction.content}`,
          createdAt: reaction.createdAt,
          sourceUrl: postRef.publicUrl,
          untrusted: true as const,
        })),
        nextCursor: nextCursor('reaction', page, reactions.length),
        truncated: reactions.length === PAGE_SIZE && page === MAX_PAGES,
      };
    }
    if (postRef.publicUrl.startsWith(this.#issueUrlPrefix)) {
      const issueNumber = positiveInteger(postRef.postId, 'Issue number');
      if (postRef.publicUrl !== `${this.#issueUrlPrefix}${issueNumber}`) {
        throw new MarketingOpsError('INVALID_INPUT', 'Issue URL does not match the post ID');
      }
      const page = decodeCursor(cursor, 'issue-comment');
      const comments = await readPlatform(() =>
        this.#client.listIssueComments(this.#repository, issueNumber, page),
      );
      return {
        items: comments.map((comment) => ({
          id: `issue-comment:${comment.id}`,
          kind: 'comment' as const,
          authorAlias: comment.userLogin,
          body: comment.body,
          createdAt: comment.createdAt,
          sourceUrl: comment.htmlUrl,
          untrusted: true as const,
        })),
        nextCursor: nextCursor('issue-comment', page, comments.length),
        truncated: comments.length === PAGE_SIZE && page === MAX_PAGES,
      };
    }
    throw new MarketingOpsError('INVALID_INPUT', 'Unsupported GitHub feedback URL');
  }

  async #allReactions(releaseId: number) {
    const items: GitHubReleaseReaction[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await readPlatform(() =>
        this.#client.listReleaseReactions(this.#repository, releaseId, page),
      );
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  #validateReleaseReceipt(receipt: PublishReceipt): number {
    if (
      receipt.channel !== 'github' ||
      receipt.status !== 'published' ||
      !receipt.publicUrl.startsWith(this.#releaseUrlPrefix)
    ) {
      throw new MarketingOpsError('INVALID_INPUT', 'Receipt is not a published GitHub release');
    }
    return positiveInteger(receipt.postId, 'Release ID');
  }
}
