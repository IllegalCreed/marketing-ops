import { z } from 'zod';
import { AdapterError, mapAdapterTransportError } from './adapters/contract.js';
import type { DevArticleRecord } from './adapters/dev-article.js';
import { MarketingOpsError } from './errors.js';
import type { PublicPostRef, PublishReceipt } from './receipt-store.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_COMMENT_DEPTH = 20;
const MAX_COMMENTS_PER_PAGE = 2_000;
const urlPattern = /^https:\/\/dev\.to\/[a-z0-9][a-z0-9_-]{1,63}\/[a-z0-9][a-z0-9-]{0,255}$/;

export interface DevCommentRecord {
  id: string;
  bodyHtml: string;
  createdAt: string;
  authorAlias: string;
  children: DevCommentRecord[];
}

export interface DevObservabilityClient {
  getArticle(articleId: number): Promise<DevArticleRecord>;
  listComments(articleId: number, page: number): Promise<DevCommentRecord[]>;
}

const cursorSchema = z
  .object({
    v: z.literal(1),
    channel: z.literal('dev'),
    page: z.number().int().min(2).max(MAX_PAGES),
  })
  .strict();

function positiveArticleId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new MarketingOpsError('INVALID_INPUT', 'DEV article ID must be a positive integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MarketingOpsError('INVALID_INPUT', 'DEV article ID must be a safe integer');
  }
  return parsed;
}

function validatePostRef(postRef: PublicPostRef): number {
  if (postRef.channel !== 'dev' || !urlPattern.test(postRef.publicUrl)) {
    throw new MarketingOpsError('INVALID_INPUT', 'DEV collector requires a DEV article');
  }
  return positiveArticleId(postRef.postId);
}

function encodeCursor(page: number): string {
  return Buffer.from(JSON.stringify({ v: 1, channel: 'dev', page }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown,
    ).page;
  } catch {
    throw new MarketingOpsError('INVALID_INPUT', 'Feedback cursor is invalid');
  }
}

async function readPlatform<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof MarketingOpsError || error instanceof AdapterError) throw error;
    throw mapAdapterTransportError(error);
  }
}

function assertArticle(article: DevArticleRecord, articleId: number, publicUrl: string): void {
  if (article.id !== articleId || article.publicUrl !== publicUrl) {
    throw new AdapterError('UNKNOWN_RESULT', 'DEV article does not match the receipt', {
      retryable: false,
      stage: 'before-submit',
      lookupRequired: true,
    });
  }
}

function flattenComments(comments: DevCommentRecord[]): DevCommentRecord[] {
  const result: DevCommentRecord[] = [];
  const visit = (comment: DevCommentRecord, depth: number): void => {
    if (depth > MAX_COMMENT_DEPTH || result.length >= MAX_COMMENTS_PER_PAGE) {
      throw new AdapterError('TEMPORARY_FAILURE', 'DEV comment tree exceeded safety bounds', {
        retryable: true,
        stage: 'before-submit',
      });
    }
    result.push(comment);
    for (const child of comment.children) visit(child, depth + 1);
  };
  for (const comment of comments) visit(comment, 1);
  return result;
}

export class DevCollector {
  readonly #client: DevObservabilityClient;
  readonly #now: () => string;

  constructor(options: { client: DevObservabilityClient; now?: () => string }) {
    this.#client = options.client;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async collect(receipt: PublishReceipt) {
    if (receipt.channel !== 'dev' || receipt.status !== 'published') {
      throw new MarketingOpsError('INVALID_INPUT', 'Receipt is not a published DEV article');
    }
    const articleId = validatePostRef(receipt);
    const article = await readPlatform(() => this.#client.getArticle(articleId));
    assertArticle(article, articleId, receipt.publicUrl);
    return {
      schemaVersion: 1 as const,
      channel: 'dev' as const,
      scope: 'article-lifetime' as const,
      attribution: 'post-level' as const,
      collectedAt: this.#now(),
      article: {
        postId: String(article.id),
        publicUrl: article.publicUrl,
        publishedAt: article.publishedAt,
        comments: article.commentsCount,
        reactions: {
          public: article.publicReactionsCount,
          positive: article.positiveReactionsCount,
        },
        pageViews: { status: 'unavailable' as const, reason: 'not-in-stable-article-response' },
      },
      limitations: ['article-counts-are-lifetime-totals', 'page-views-not-collected'],
    };
  }

  async listFeedback(postRef: PublicPostRef, cursor?: string) {
    const articleId = validatePostRef(postRef);
    const page = decodeCursor(cursor);
    const article = await readPlatform(() => this.#client.getArticle(articleId));
    assertArticle(article, articleId, postRef.publicUrl);
    const roots = await readPlatform(() => this.#client.listComments(articleId, page));
    const comments = flattenComments(roots);
    return {
      items: comments.map((comment) => ({
        id: `dev-comment:${comment.id}`,
        kind: 'comment' as const,
        authorAlias: comment.authorAlias,
        body: comment.bodyHtml,
        createdAt: comment.createdAt,
        sourceUrl: `${postRef.publicUrl}#comment-${comment.id}`,
        untrusted: true as const,
      })),
      nextCursor: roots.length === PAGE_SIZE && page < MAX_PAGES ? encodeCursor(page + 1) : null,
      truncated: roots.length === PAGE_SIZE && page === MAX_PAGES,
    };
  }
}
