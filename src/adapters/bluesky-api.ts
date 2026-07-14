import { AtpAgent, RichText } from '@atproto/api';
import { z } from 'zod';
import { MarketingOpsError } from '../errors.js';
import { AdapterTransportError } from './contract.js';
import type { BlueskyPostLookup, BlueskyPostRecord, BlueskyTextDraft } from './bluesky-post.js';

export interface BlueskyCredentials {
  handle: string;
  appPassword: string;
}

export interface BlueskyApiHealth {
  health: 'ready' | 'reauth-required' | 'blocked';
  alias: string | null;
  did: string | null;
  reason: 'READY' | 'REAUTH_REQUIRED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID_RESPONSE';
}

export interface BlueskySdkClient {
  login(input: { identifier: string; password: string }): Promise<unknown>;
  getProfile(input: { actor: string }): Promise<unknown>;
  getAuthorFeed(input: { actor: string; filter: 'posts_no_replies'; limit: 100 }): Promise<unknown>;
  post(input: {
    text: string;
    facets?: NonNullable<RichText['facets']>;
    langs: ['en'];
    createdAt: string;
  }): Promise<unknown>;
  deletePost(postUri: string): Promise<void>;
}

export type BlueskySdkFactory = () => BlueskySdkClient;

interface BlueskyApiClientOptions {
  credentials: BlueskyCredentials;
  sdkFactory?: BlueskySdkFactory;
  now?: () => string;
}

interface BlueskyIdentity {
  did: string;
  handle: string;
}

class InvalidBlueskyResponseError extends Error {
  constructor() {
    super('Bluesky returned an invalid response');
    this.name = 'InvalidBlueskyResponseError';
  }
}

const handlePattern =
  /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const didPattern = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const atUriPattern =
  /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]+)$/;

const identitySchema = z
  .object({
    data: z
      .object({
        did: z.string().regex(didPattern),
        handle: z.string().regex(handlePattern),
      })
      .passthrough(),
  })
  .passthrough();

const feedResponseSchema = z
  .object({ data: z.object({ feed: z.array(z.unknown()) }).passthrough() })
  .passthrough();

const feedPostSchema = z
  .object({
    post: z
      .object({
        uri: z.string().regex(atUriPattern),
        cid: z.string().min(1).max(256),
        author: z
          .object({
            did: z.string().regex(didPattern),
            handle: z.string().regex(handlePattern),
          })
          .passthrough(),
        record: z
          .object({
            text: z.string().min(1).max(3_000),
            createdAt: z.iso.datetime({ offset: true }),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const createPostResponseSchema = z
  .object({
    uri: z.string().regex(atUriPattern),
    cid: z.string().min(1).max(256),
  })
  .passthrough();

function defaultSdkFactory(): BlueskySdkClient {
  return new AtpAgent({ service: 'https://bsky.social' });
}

export function normalizeBlueskyCredentials(value: BlueskyCredentials): BlueskyCredentials {
  const handle = value.handle.trim().replace(/^@/, '').toLowerCase();
  if (!handlePattern.test(handle)) {
    throw new MarketingOpsError('INVALID_INPUT', 'Bluesky handle is invalid');
  }
  if (!/^[A-Za-z0-9-]{8,128}$/.test(value.appPassword)) {
    throw new MarketingOpsError('INVALID_INPUT', 'A dedicated Bluesky App Password is required');
  }
  return { handle, appPassword: value.appPassword };
}

function statusFromError(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('status' in error && typeof error.status === 'number') return error.status;
  if (
    'response' in error &&
    typeof error.response === 'object' &&
    error.response !== null &&
    'status' in error.response &&
    typeof error.response.status === 'number'
  ) {
    return error.response.status;
  }
  return undefined;
}

function retryAfterFromError(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('headers' in error)) return undefined;
  const headers = error.headers;
  let value: string | null | undefined;
  if (headers instanceof Headers) value = headers.get('retry-after');
  else if (typeof headers === 'object' && headers !== null && 'retry-after' in headers) {
    const candidate = headers['retry-after'];
    if (typeof candidate === 'string') value = candidate;
  }
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(86_400, Math.max(1, Math.trunc(parsed))) : undefined;
}

function transportError(
  error: unknown,
  stage: 'before-submit' | 'after-submit',
): AdapterTransportError {
  const status = statusFromError(error);
  const retryAfterSeconds = retryAfterFromError(error);
  return new AdapterTransportError('Bluesky request failed', {
    ...(status === undefined ? {} : { status }),
    timeout: error instanceof TypeError,
    stage,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

function publicUrl(uri: string): string {
  const match = atUriPattern.exec(uri);
  if (!match) throw new InvalidBlueskyResponseError();
  return `https://bsky.app/profile/${match[1]}/post/${match[2]}`;
}

function recordFromFeed(value: unknown, expectedDid: string): BlueskyPostRecord {
  const parsed = feedPostSchema.safeParse(value);
  if (!parsed.success || parsed.data.post.author.did !== expectedDid) {
    throw new InvalidBlueskyResponseError();
  }
  const post = parsed.data.post;
  return {
    uri: post.uri,
    cid: post.cid,
    text: post.record.text,
    publicUrl: publicUrl(post.uri),
    publishedAt: post.record.createdAt,
  };
}

export class BlueskyApiClient {
  readonly #credentials: BlueskyCredentials;
  readonly #sdk: BlueskySdkClient;
  readonly #now: () => string;
  #identity: BlueskyIdentity | null = null;

  constructor(options: BlueskyApiClientOptions) {
    this.#credentials = normalizeBlueskyCredentials(options.credentials);
    this.#sdk = (options.sdkFactory ?? defaultSdkFactory)();
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async checkHealth(): Promise<BlueskyApiHealth> {
    try {
      const identity = await this.#authenticate();
      const profile = identitySchema.safeParse(await this.#sdk.getProfile({ actor: identity.did }));
      if (
        !profile.success ||
        profile.data.data.did !== identity.did ||
        profile.data.data.handle !== identity.handle
      ) {
        throw new InvalidBlueskyResponseError();
      }
      return {
        health: 'ready',
        alias: identity.handle,
        did: identity.did,
        reason: 'READY',
      };
    } catch (error) {
      if (error instanceof InvalidBlueskyResponseError) {
        return {
          health: 'blocked',
          alias: null,
          did: null,
          reason: 'INVALID_RESPONSE',
        };
      }
      const status = statusFromError(error);
      return {
        health: status === 401 ? 'reauth-required' : 'blocked',
        alias: null,
        did: null,
        reason:
          status === 401 ? 'REAUTH_REQUIRED' : status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE',
      };
    }
  }

  async findRecentPostByText(text: string): Promise<BlueskyPostLookup> {
    const identity = await this.#identityForOperation('before-submit');
    let response: unknown;
    try {
      response = await this.#sdk.getAuthorFeed({
        actor: identity.did,
        filter: 'posts_no_replies',
        limit: 100,
      });
    } catch (error) {
      throw transportError(error, 'before-submit');
    }
    const parsed = feedResponseSchema.safeParse(response);
    if (!parsed.success) throw transportError(new InvalidBlueskyResponseError(), 'before-submit');
    for (const item of parsed.data.data.feed) {
      let post: BlueskyPostRecord;
      try {
        post = recordFromFeed(item, identity.did);
      } catch (error) {
        throw transportError(error, 'before-submit');
      }
      if (post.text === text) return { complete: true, post };
    }
    return { complete: true, post: null };
  }

  async createTextPost(draft: BlueskyTextDraft): Promise<BlueskyPostRecord> {
    const identity = await this.#identityForOperation('before-submit');
    const createdAt = this.#now();
    const richText = new RichText({ text: draft.text });
    richText.detectFacetsWithoutResolution();
    const facets = richText.facets?.filter((facet) =>
      facet.features.every((feature) => feature.$type !== 'app.bsky.richtext.facet#mention'),
    );
    let response: unknown;
    try {
      response = await this.#sdk.post({
        text: draft.text,
        ...(facets && facets.length > 0 ? { facets } : {}),
        langs: draft.langs,
        createdAt,
      });
    } catch (error) {
      throw transportError(error, 'after-submit');
    }
    const parsed = createPostResponseSchema.safeParse(response);
    if (!parsed.success) throw transportError(new InvalidBlueskyResponseError(), 'after-submit');
    return {
      uri: parsed.data.uri,
      cid: parsed.data.cid,
      text: draft.text,
      publicUrl: publicUrl(parsed.data.uri),
      publishedAt: createdAt,
    };
  }

  async deleteTextPost(uri: string): Promise<{ status: 'deleted' }> {
    const identity = await this.#identityForOperation('before-submit');
    const match = atUriPattern.exec(uri);
    if (!match || match[1] !== identity.did) {
      throw new AdapterTransportError('Bluesky post ownership did not match', {
        status: 403,
        stage: 'before-submit',
      });
    }
    try {
      await this.#sdk.deletePost(uri);
      return { status: 'deleted' };
    } catch (error) {
      throw transportError(error, 'after-submit');
    }
  }

  async #authenticate(): Promise<BlueskyIdentity> {
    if (this.#identity) return this.#identity;
    const parsed = identitySchema.safeParse(
      await this.#sdk.login({
        identifier: this.#credentials.handle,
        password: this.#credentials.appPassword,
      }),
    );
    if (!parsed.success) throw new InvalidBlueskyResponseError();
    this.#identity = { did: parsed.data.data.did, handle: parsed.data.data.handle };
    return this.#identity;
  }

  async #identityForOperation(stage: 'before-submit' | 'after-submit'): Promise<BlueskyIdentity> {
    try {
      return await this.#authenticate();
    } catch (error) {
      throw transportError(error, stage);
    }
  }
}
