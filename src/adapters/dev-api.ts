import { z } from 'zod';
import { MarketingOpsError } from '../errors.js';
import type { DevCommentRecord, DevObservabilityClient } from '../dev-observability.js';
import { AdapterTransportError } from './contract.js';
import type {
  DevArticleClient,
  DevArticleDraft,
  DevArticleLookup,
  DevArticleRecord,
} from './dev-article.js';

export interface DevApiHealth {
  health: 'ready' | 'reauth-required' | 'blocked';
  alias: string | null;
  userId: number | null;
  reason: 'READY' | 'REAUTH_REQUIRED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID_RESPONSE';
}

export type DevFetch = (input: string, init: RequestInit) => Promise<Response>;

interface DevApiClientOptions {
  apiKey: string;
  fetcher?: DevFetch;
}

const API_ROOT = 'https://dev.to/api';
const ACCEPT = 'application/vnd.forem.api-v1+json';
const MAX_RESPONSE_BYTES = 2_000_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const usernamePattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const devArticleUrlPattern =
  /^https:\/\/dev\.to\/[a-z0-9][a-z0-9_-]{1,63}\/[a-z0-9][a-z0-9-]{0,255}$/;

const identitySchema = z
  .object({
    id: z.number().int().positive().safe(),
    username: z.string().regex(usernamePattern),
  })
  .passthrough();

const articleSummarySchema = z
  .object({
    id: z.number().int().positive().safe(),
    title: z.string().min(1).max(512),
    canonical_url: z.string().url().nullable(),
    url: z.string().url(),
  })
  .passthrough();

const articleRecordSchema = z
  .object({
    id: z.number().int().positive().safe(),
    title: z.string().min(1).max(512),
    body_markdown: z.string().min(1).max(100_000),
    canonical_url: z.string().url(),
    url: z.string().regex(devArticleUrlPattern),
    published_at: z.iso.datetime({ offset: true }),
    comments_count: z.number().int().nonnegative().safe().optional().default(0),
    public_reactions_count: z.number().int().nonnegative().safe().optional().default(0),
    positive_reactions_count: z.number().int().nonnegative().safe().optional().default(0),
  })
  .passthrough();

interface RawComment {
  id_code: string;
  body_html: string;
  created_at: string;
  user: { username: string };
  children: RawComment[];
}

const rawCommentSchema: z.ZodType<RawComment> = z.lazy(() =>
  z
    .object({
      id_code: z.string().min(1).max(200),
      body_html: z.string().max(100_000),
      created_at: z.iso.datetime({ offset: true }),
      user: z.object({ username: z.string().regex(usernamePattern) }).passthrough(),
      children: z.array(rawCommentSchema).max(1_000),
    })
    .passthrough(),
);

class InvalidDevResponseError extends Error {
  constructor() {
    super('DEV returned an invalid response');
    this.name = 'InvalidDevResponseError';
  }
}

export function normalizeDevApiKey(value: string): string {
  if (!/^[\x21-\x7e]{16,256}$/.test(value)) {
    throw new MarketingOpsError('INVALID_INPUT', 'DEV API key is invalid');
  }
  return value;
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.min(86_400, Math.max(1, Math.trunc(seconds))) : undefined;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new InvalidDevResponseError();
  }
  if (!response.body) throw new InvalidDevResponseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new InvalidDevResponseError();
    }
    chunks.push(result.value);
  }
  try {
    return JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        size,
      ).toString('utf8'),
    ) as unknown;
  } catch {
    throw new InvalidDevResponseError();
  }
}

function toRecord(value: unknown): DevArticleRecord {
  const parsed = articleRecordSchema.safeParse(value);
  if (!parsed.success) throw new InvalidDevResponseError();
  return {
    id: parsed.data.id,
    title: parsed.data.title,
    bodyMarkdown: parsed.data.body_markdown,
    canonicalUrl: parsed.data.canonical_url,
    publicUrl: parsed.data.url,
    publishedAt: new Date(parsed.data.published_at).toISOString(),
    commentsCount: parsed.data.comments_count,
    publicReactionsCount: parsed.data.public_reactions_count,
    positiveReactionsCount: parsed.data.positive_reactions_count,
  };
}

function toComment(value: RawComment): DevCommentRecord {
  return {
    id: value.id_code,
    bodyHtml: value.body_html,
    createdAt: new Date(value.created_at).toISOString(),
    authorAlias: value.user.username,
    children: value.children.map(toComment),
  };
}

export class DevApiClient implements DevArticleClient, DevObservabilityClient {
  readonly #apiKey: string;
  readonly #fetcher: DevFetch;

  constructor(options: DevApiClientOptions) {
    this.#apiKey = normalizeDevApiKey(options.apiKey);
    this.#fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  async checkHealth(): Promise<DevApiHealth> {
    try {
      const parsed = identitySchema.safeParse(
        await this.#request('/users/me', 'GET', 'before-submit'),
      );
      if (!parsed.success) throw new InvalidDevResponseError();
      return {
        health: 'ready',
        alias: parsed.data.username,
        userId: parsed.data.id,
        reason: 'READY',
      };
    } catch (error) {
      if (error instanceof InvalidDevResponseError) {
        return { health: 'blocked', alias: null, userId: null, reason: 'INVALID_RESPONSE' };
      }
      const status = error instanceof AdapterTransportError ? error.status : undefined;
      return {
        health: status === 401 ? 'reauth-required' : 'blocked',
        alias: null,
        userId: null,
        reason:
          status === 401 ? 'REAUTH_REQUIRED' : status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE',
      };
    }
  }

  async findArticle(draft: DevArticleDraft): Promise<DevArticleLookup> {
    const candidates: Array<z.infer<typeof articleSummarySchema>> = [];
    let complete = false;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const value = await this.#request(
        `/articles/me/all?page=${page}&per_page=${PAGE_SIZE}`,
        'GET',
        'before-submit',
      );
      const parsed = z.array(articleSummarySchema).max(PAGE_SIZE).safeParse(value);
      if (!parsed.success) throw this.#invalidTransport('before-submit');
      candidates.push(
        ...parsed.data.filter(
          (article) =>
            article.title === draft.title && article.canonical_url === draft.canonicalUrl,
        ),
      );
      if (parsed.data.length < PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    if (!complete) return { complete: false, article: null };
    if (candidates.length > 1) throw this.#invalidTransport('before-submit');
    const candidate = candidates[0];
    return {
      complete: true,
      article: candidate ? await this.getArticle(candidate.id) : null,
    };
  }

  async createArticle(draft: DevArticleDraft): Promise<DevArticleRecord> {
    const value = await this.#request('/articles', 'POST', 'after-submit', {
      article: {
        title: draft.title,
        body_markdown: draft.bodyMarkdown,
        canonical_url: draft.canonicalUrl,
        published: true,
        tags: draft.tags,
      },
    });
    try {
      return toRecord(value);
    } catch {
      throw this.#invalidTransport('after-submit');
    }
  }

  async getArticle(articleId: number): Promise<DevArticleRecord> {
    if (!Number.isSafeInteger(articleId) || articleId < 1) {
      throw new MarketingOpsError('INVALID_INPUT', 'DEV article ID must be a positive integer');
    }
    const value = await this.#request(`/articles/${articleId}`, 'GET', 'before-submit');
    try {
      return toRecord(value);
    } catch {
      throw this.#invalidTransport('before-submit');
    }
  }

  async listComments(articleId: number, page: number): Promise<DevCommentRecord[]> {
    if (
      !Number.isSafeInteger(articleId) ||
      articleId < 1 ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > MAX_PAGES
    ) {
      throw new MarketingOpsError('INVALID_INPUT', 'DEV comment query is invalid');
    }
    const value = await this.#request(
      `/comments?a_id=${articleId}&page=${page}&per_page=${PAGE_SIZE}`,
      'GET',
      'before-submit',
    );
    const parsed = z.array(rawCommentSchema).max(PAGE_SIZE).safeParse(value);
    if (!parsed.success) throw this.#invalidTransport('before-submit');
    return parsed.data.map(toComment);
  }

  async #request(
    path: string,
    method: 'GET' | 'POST',
    stage: 'before-submit' | 'after-submit',
    body?: object,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetcher(`${API_ROOT}${path}`, {
        method,
        headers: {
          Accept: ACCEPT,
          'api-key': this.#apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(10_000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AdapterTransportError('DEV request failed', { timeout: true, stage });
    }
    if (!response.ok) {
      const retryAfterSeconds = retryAfter(response);
      throw new AdapterTransportError('DEV request failed', {
        status: response.status,
        stage,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      });
    }
    try {
      return await readBoundedJson(response);
    } catch {
      throw this.#invalidTransport(stage);
    }
  }

  #invalidTransport(stage: 'before-submit' | 'after-submit'): AdapterTransportError {
    return new AdapterTransportError('DEV returned an invalid response', { stage });
  }
}
