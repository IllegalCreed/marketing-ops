import { z } from 'zod';
import { MarketingOpsError } from '../errors.js';
import { AdapterTransportError } from './contract.js';

export interface MastodonCredentials {
  instanceUrl: string;
  accessToken: string;
}

export interface MastodonApiHealth {
  health: 'ready' | 'reauth-required' | 'blocked';
  instanceUrl: string;
  alias: string | null;
  accountId: string | null;
  reason: 'READY' | 'REAUTH_REQUIRED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID_RESPONSE';
}

export interface MastodonStatusRecord {
  id: string;
  uri: string;
  text: string;
  publicUrl: string;
  publishedAt: string;
  replyCount: number;
  reblogCount: number;
  favouriteCount: number;
}

export interface MastodonStatusLookup {
  complete: boolean;
  status: MastodonStatusRecord | null;
}

export interface MastodonNotificationRecord {
  id: string;
  type: 'mention' | 'favourite' | 'reblog' | 'reply';
  createdAt: string;
  authorAlias: string;
  statusId: string;
  statusUrl: string;
  bodyHtml: string;
}

export interface MastodonStatusDraft {
  text: string;
  visibility: 'public';
  language: 'en' | 'zh';
  idempotencyKey: string;
}

export type MastodonFetch = (input: string, init: RequestInit) => Promise<Response>;

interface MastodonApiClientOptions {
  credentials: MastodonCredentials;
  fetcher?: MastodonFetch;
}

const MAX_RESPONSE_BYTES = 2_000_000;
const NOTIFICATION_TYPES = ['mention', 'favourite', 'reblog', 'reply'] as const;
const instanceHostPattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const instanceUrlPattern = /^https:\/\/[a-z0-9.-]+(?::\d{2,5})?$/i;
const accountIdPattern = /^[1-9]\d{0,63}$/;
const aliasPattern =
  /^(?=.{1,255}$)[a-z0-9_][a-z0-9_.-]{0,127}(?:@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)?$/i;

const verifyCredentialsSchema = z
  .object({
    id: z.string().regex(accountIdPattern),
    acct: z.string().regex(aliasPattern),
    url: z.string().url(),
  })
  .passthrough();

const statusSchema = z
  .object({
    id: z.string().regex(accountIdPattern),
    uri: z.string().url(),
    created_at: z.iso.datetime({ offset: true }),
    url: z.string().url(),
    content: z.string().max(100_000),
    text: z.string().max(100_000).optional(),
    account: z
      .object({
        id: z.string().regex(accountIdPattern),
        acct: z.string().regex(aliasPattern),
      })
      .passthrough(),
    replies_count: z.number().int().nonnegative().safe(),
    reblogs_count: z.number().int().nonnegative().safe(),
    favourites_count: z.number().int().nonnegative().safe(),
  })
  .passthrough();

const notificationSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.enum(NOTIFICATION_TYPES),
    created_at: z.iso.datetime({ offset: true }),
    account: z.object({ acct: z.string().regex(aliasPattern) }).passthrough(),
    status: z
      .object({
        id: z.string().regex(accountIdPattern),
        url: z.string().url(),
        content: z.string().max(100_000),
      })
      .passthrough(),
  })
  .passthrough();

class InvalidMastodonResponseError extends Error {
  constructor() {
    super('Mastodon returned an invalid response');
    this.name = 'InvalidMastodonResponseError';
  }
}

export function normalizeMastodonCredentials(value: MastodonCredentials): MastodonCredentials {
  const rawUrl = value.instanceUrl.trim();
  const rawToken = value.accessToken.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new MarketingOpsError('INVALID_INPUT', 'Mastodon instance URL is invalid');
  }
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.search ||
    parsedUrl.hash ||
    (parsedUrl.pathname && parsedUrl.pathname !== '/') ||
    !instanceHostPattern.test(parsedUrl.hostname)
  ) {
    throw new MarketingOpsError('INVALID_INPUT', 'Mastodon instance URL is invalid');
  }
  const instanceUrl = parsedUrl.origin;
  if (!instanceUrlPattern.test(instanceUrl)) {
    throw new MarketingOpsError('INVALID_INPUT', 'Mastodon instance URL is invalid');
  }
  if (!/^[\x21-\x7e]{16,256}$/.test(rawToken)) {
    throw new MarketingOpsError('INVALID_INPUT', 'Mastodon access token is invalid');
  }
  return { instanceUrl, accessToken: rawToken };
}

function publicAccountAlias(acct: string, instanceUrl: string): string {
  return acct.includes('@') ? acct : `${acct}@${new URL(instanceUrl).hostname}`;
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
    throw new InvalidMastodonResponseError();
  }
  if (!response.body) throw new InvalidMastodonResponseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new InvalidMastodonResponseError();
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
    throw new InvalidMastodonResponseError();
  }
}

function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function toStatusRecord(value: unknown): MastodonStatusRecord {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success) throw new InvalidMastodonResponseError();
  return {
    id: parsed.data.id,
    uri: parsed.data.uri,
    text: parsed.data.text ?? htmlToText(parsed.data.content),
    publicUrl: parsed.data.url,
    publishedAt: new Date(parsed.data.created_at).toISOString(),
    replyCount: parsed.data.replies_count,
    reblogCount: parsed.data.reblogs_count,
    favouriteCount: parsed.data.favourites_count,
  };
}

function toNotificationRecord(value: unknown): MastodonNotificationRecord {
  const parsed = notificationSchema.safeParse(value);
  if (!parsed.success) throw new InvalidMastodonResponseError();
  return {
    id: parsed.data.id,
    type: parsed.data.type,
    createdAt: new Date(parsed.data.created_at).toISOString(),
    authorAlias: parsed.data.account.acct,
    statusId: parsed.data.status.id,
    statusUrl: parsed.data.status.url,
    bodyHtml: parsed.data.status.content,
  };
}

export class MastodonApiClient {
  readonly #credentials: MastodonCredentials;
  readonly #fetcher: MastodonFetch;

  constructor(options: MastodonApiClientOptions) {
    this.#credentials = normalizeMastodonCredentials(options.credentials);
    this.#fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  async checkHealth(): Promise<MastodonApiHealth> {
    try {
      const parsed = verifyCredentialsSchema.safeParse(
        await this.#request('/api/v1/accounts/verify_credentials', {
          method: 'GET',
          stage: 'before-submit',
        }),
      );
      if (!parsed.success) throw new InvalidMastodonResponseError();
      return {
        health: 'ready',
        instanceUrl: this.#credentials.instanceUrl,
        alias: publicAccountAlias(parsed.data.acct, this.#credentials.instanceUrl),
        accountId: parsed.data.id,
        reason: 'READY',
      };
    } catch (error) {
      if (error instanceof InvalidMastodonResponseError) {
        return {
          health: 'blocked',
          instanceUrl: this.#credentials.instanceUrl,
          alias: null,
          accountId: null,
          reason: 'INVALID_RESPONSE',
        };
      }
      const status = error instanceof AdapterTransportError ? error.status : undefined;
      return {
        health: status === 401 ? 'reauth-required' : 'blocked',
        instanceUrl: this.#credentials.instanceUrl,
        alias: null,
        accountId: null,
        reason:
          status === 401 ? 'REAUTH_REQUIRED' : status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE',
      };
    }
  }

  async findRecentStatusByText(text: string, accountId: string): Promise<MastodonStatusLookup> {
    if (!accountIdPattern.test(accountId)) {
      throw new MarketingOpsError('INVALID_INPUT', 'Mastodon account ID is invalid');
    }
    const value = await this.#request(
      `/api/v1/accounts/${accountId}/statuses?limit=40&exclude_reblogs=true&exclude_replies=true`,
      { method: 'GET', stage: 'before-submit' },
    );
    const parsed = z.array(statusSchema).max(40).safeParse(value);
    if (!parsed.success) throw this.#invalidTransport('before-submit');
    const match = parsed.data.map(toStatusRecord).find((status) => status.text === text) ?? null;
    return { complete: true, status: match };
  }

  async createStatus(draft: MastodonStatusDraft): Promise<MastodonStatusRecord> {
    const body = new URLSearchParams({
      status: draft.text,
      visibility: draft.visibility,
      language: draft.language,
    }).toString();
    const value = await this.#request('/api/v1/statuses', {
      method: 'POST',
      stage: 'after-submit',
      body,
      headers: { 'Idempotency-Key': draft.idempotencyKey },
    });
    try {
      return toStatusRecord(value);
    } catch {
      throw this.#invalidTransport('after-submit');
    }
  }

  async deleteStatus(statusId: string): Promise<{ status: 'deleted' }> {
    if (!accountIdPattern.test(statusId)) {
      throw new MarketingOpsError('INVALID_INPUT', 'Mastodon status ID is invalid');
    }
    await this.#request(`/api/v1/statuses/${statusId}`, {
      method: 'DELETE',
      stage: 'after-submit',
    });
    return { status: 'deleted' };
  }

  async getStatus(statusId: string): Promise<MastodonStatusRecord> {
    if (!accountIdPattern.test(statusId)) {
      throw new MarketingOpsError('INVALID_INPUT', 'Mastodon status ID is invalid');
    }
    const value = await this.#request(`/api/v1/statuses/${statusId}`, {
      method: 'GET',
      stage: 'before-submit',
    });
    try {
      return toStatusRecord(value);
    } catch {
      throw this.#invalidTransport('before-submit');
    }
  }

  async listNotifications(): Promise<MastodonNotificationRecord[]> {
    const query = NOTIFICATION_TYPES.map((type) => `types[]=${encodeURIComponent(type)}`).join('&');
    const value = await this.#request(`/api/v1/notifications?limit=40&${query}`, {
      method: 'GET',
      stage: 'before-submit',
    });
    const parsed = z.array(notificationSchema).max(40).safeParse(value);
    if (!parsed.success) throw this.#invalidTransport('before-submit');
    return parsed.data.map(toNotificationRecord);
  }

  async #request(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'DELETE';
      stage: 'before-submit' | 'after-submit';
      body?: string;
      headers?: Record<string, string>;
    },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetcher(`${this.#credentials.instanceUrl}${path}`, {
        method: options.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.#credentials.accessToken}`,
          ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(10_000),
        ...(options.body ? { body: options.body } : {}),
      });
    } catch {
      throw new AdapterTransportError('Mastodon request failed', {
        timeout: true,
        stage: options.stage,
      });
    }
    if (!response.ok) {
      const retryAfterSeconds = retryAfter(response);
      throw new AdapterTransportError('Mastodon request failed', {
        status: response.status,
        stage: options.stage,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      });
    }
    if (options.method === 'DELETE') return {};
    try {
      return await readBoundedJson(response);
    } catch {
      throw this.#invalidTransport(options.stage);
    }
  }

  #invalidTransport(stage: 'before-submit' | 'after-submit'): AdapterTransportError {
    return new AdapterTransportError('Mastodon returned an invalid response', { stage });
  }
}
