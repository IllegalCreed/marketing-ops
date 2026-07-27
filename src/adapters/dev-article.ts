import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AdapterError,
  createPublishedReceipt,
  defineAdapter,
  mapAdapterTransportError,
  parseAdapterPublishInput,
  requireAdapterCapability,
  type AdapterPublishInput,
  type AdapterPublishResult,
  type ChannelAdapter,
} from './contract.js';

export interface DevArticleDraft {
  title: string;
  bodyMarkdown: string;
  canonicalUrl: string;
  published: true;
  tags: string;
}

export interface DevArticleRecord {
  id: number;
  title: string;
  bodyMarkdown: string;
  canonicalUrl: string;
  publicUrl: string;
  publishedAt: string;
  commentsCount: number;
  publicReactionsCount: number;
  positiveReactionsCount: number;
}

export interface DevArticleLookup {
  complete: boolean;
  article: DevArticleRecord | null;
}

export interface DevArticleClient {
  findArticle(draft: DevArticleDraft): Promise<DevArticleLookup>;
  createArticle(draft: DevArticleDraft): Promise<DevArticleRecord>;
}

const DEFINITION = defineAdapter({
  channel: 'dev',
  version: 'dev-article@0.2.0',
  capabilities: {
    publish: true,
    status: true,
    metrics: true,
    feedback: true,
    reply: false,
    delete: false,
  },
});

const devArticleUrlPattern =
  /^https:\/\/dev\.to\/[a-z0-9][a-z0-9_-]{1,63}\/[a-z0-9][a-z0-9-]{0,255}$/;
const recordSchema = z
  .object({
    id: z.number().int().positive().safe(),
    title: z.string().min(1).max(128),
    bodyMarkdown: z.string().min(1).max(100_000),
    canonicalUrl: z.url().startsWith('https://'),
    publicUrl: z.string().regex(devArticleUrlPattern),
    publishedAt: z.iso.datetime({ offset: true }),
    commentsCount: z.number().int().nonnegative().safe(),
    publicReactionsCount: z.number().int().nonnegative().safe(),
    positiveReactionsCount: z.number().int().nonnegative().safe(),
  })
  .strict();

function marker(input: AdapterPublishInput): string {
  const idempotencyHash = createHash('sha256').update(input.idempotencyKey).digest('hex');
  return `<!-- marketing-ops:v2 project=${input.projectId} content-sha256=${input.contentHash} idempotency-sha256=${idempotencyHash} -->`;
}

function canonicalFromTrackedLink(value: string): string {
  const url = new URL(value);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

export interface DevArticleProjectPolicy {
  canonicalOrigins: readonly string[];
  tags: readonly string[];
}

function parsePolicy(value: DevArticleProjectPolicy): {
  canonicalOrigins: string[];
  tags: string[];
} {
  const canonicalOrigins = [...new Set(value.canonicalOrigins)].sort();
  const tags = [...new Set(value.tags)].sort();
  if (
    canonicalOrigins.length === 0 ||
    canonicalOrigins.some((origin) => {
      try {
        const url = new URL(origin);
        return (
          url.protocol !== 'https:' ||
          url.username !== '' ||
          url.password !== '' ||
          url.pathname !== '/' ||
          url.search !== '' ||
          url.hash !== '' ||
          url.origin !== origin
        );
      } catch {
        return true;
      }
    }) ||
    tags.length === 0 ||
    tags.length > 4 ||
    tags.some((tag) => !/^[a-z0-9][a-z0-9-]{0,29}$/.test(tag))
  ) {
    throw new AdapterError('INVALID_CONTENT', 'DEV project policy is invalid', {
      retryable: false,
    });
  }
  return { canonicalOrigins, tags };
}

function hasAllowedOrigin(value: string, canonicalOrigins: readonly string[]): boolean {
  return canonicalOrigins.includes(new URL(value).origin);
}

function parseInput(value: unknown, policyInput: DevArticleProjectPolicy): AdapterPublishInput {
  const policy = parsePolicy(policyInput);
  const input = parseAdapterPublishInput(value, {
    channel: 'dev',
    format: 'article',
    allowUnresolvedMedia: false,
  });
  if (input.package.variants.length !== 1 || input.package.variants[0]?.locale !== 'en') {
    throw new AdapterError('INVALID_CONTENT', 'DEV articles require one English variant', {
      retryable: false,
    });
  }
  const canonicalUrl = input.package.canonicalUrl;
  const variant = input.package.variants[0];
  if (!canonicalUrl || !hasAllowedOrigin(canonicalUrl, policy.canonicalOrigins)) {
    throw new AdapterError('INVALID_CONTENT', 'DEV canonical URL must use the project origin', {
      retryable: false,
    });
  }
  if (
    variant.links.length === 0 ||
    variant.links.some((link) => !hasAllowedOrigin(link, policy.canonicalOrigins)) ||
    variant.links.some((link) => !variant.body.includes(link)) ||
    canonicalFromTrackedLink(variant.links[0]!) !== canonicalUrl
  ) {
    throw new AdapterError('INVALID_CONTENT', 'DEV article links do not match the canonical URL', {
      retryable: false,
    });
  }
  return input;
}

export function buildDevArticleDraft(
  value: unknown,
  policyInput: DevArticleProjectPolicy,
): DevArticleDraft {
  const policy = parsePolicy(policyInput);
  const input = parseInput(value, policy);
  const variant = input.package.variants[0]!;
  return {
    title: variant.title,
    bodyMarkdown: `${marker(input)}\n\n${variant.body}`,
    canonicalUrl: input.package.canonicalUrl!,
    published: true,
    tags: policy.tags.join(', '),
  };
}

function parseRecord(
  value: unknown,
  stage: 'before-submit' | 'after-submit',
  canonicalOrigins: readonly string[],
): DevArticleRecord {
  const parsed = recordSchema.safeParse(value);
  if (parsed.success && hasAllowedOrigin(parsed.data.canonicalUrl, canonicalOrigins)) {
    return parsed.data;
  }
  if (stage === 'after-submit') {
    throw new AdapterError(
      'UNKNOWN_RESULT',
      'DEV returned an invalid article; lookup is required',
      {
        retryable: false,
        stage,
        lookupRequired: true,
      },
    );
  }
  throw new AdapterError('TEMPORARY_FAILURE', 'DEV returned an invalid article', {
    retryable: true,
    stage,
  });
}

function assertArticleMatches(
  article: DevArticleRecord,
  draft: DevArticleDraft,
  stage: 'before-submit' | 'after-submit',
): void {
  if (
    article.title === draft.title &&
    article.bodyMarkdown === draft.bodyMarkdown &&
    article.canonicalUrl === draft.canonicalUrl
  ) {
    return;
  }
  throw new AdapterError(
    stage === 'after-submit' ? 'UNKNOWN_RESULT' : 'IDEMPOTENCY_CONFLICT',
    stage === 'after-submit'
      ? 'DEV returned different article content'
      : 'Existing DEV article content does not match',
    {
      retryable: false,
      stage,
      ...(stage === 'after-submit' ? { lookupRequired: true } : {}),
    },
  );
}

export class DevArticleAdapter implements ChannelAdapter {
  readonly definition = DEFINITION;
  readonly expectedFormat = 'article' as const;
  readonly #client: DevArticleClient;
  readonly #policy: { canonicalOrigins: string[]; tags: string[] };

  constructor(options: { client: DevArticleClient } & DevArticleProjectPolicy) {
    this.#client = options.client;
    this.#policy = parsePolicy(options);
  }

  async preflight(value: AdapterPublishInput): Promise<void> {
    requireAdapterCapability(this.definition, 'publish');
    buildDevArticleDraft(value, this.#policy);
  }

  async publish(value: AdapterPublishInput): Promise<AdapterPublishResult> {
    await this.preflight(value);
    const input = parseInput(value, this.#policy);
    const draft = buildDevArticleDraft(input, this.#policy);
    let lookup: DevArticleLookup;
    try {
      lookup = await this.#client.findArticle(draft);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    if (typeof lookup.complete !== 'boolean' || !('article' in lookup)) {
      throw new AdapterError('TEMPORARY_FAILURE', 'DEV lookup returned an invalid result', {
        retryable: true,
        stage: 'before-submit',
      });
    }
    if (!lookup.complete) {
      throw new AdapterError('TEMPORARY_FAILURE', 'DEV article lookup was incomplete', {
        retryable: true,
        stage: 'before-submit',
      });
    }
    if (lookup.article) {
      const existing = parseRecord(lookup.article, 'before-submit', this.#policy.canonicalOrigins);
      assertArticleMatches(existing, draft, 'before-submit');
      return {
        reused: true,
        receipt: createPublishedReceipt(input, this.definition.version, {
          postId: String(existing.id),
          publicUrl: existing.publicUrl,
          publishedAt: existing.publishedAt,
        }),
      };
    }

    let createdValue: DevArticleRecord;
    try {
      createdValue = await this.#client.createArticle(draft);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    const created = parseRecord(createdValue, 'after-submit', this.#policy.canonicalOrigins);
    assertArticleMatches(created, draft, 'after-submit');
    return {
      reused: false,
      receipt: createPublishedReceipt(input, this.definition.version, {
        postId: String(created.id),
        publicUrl: created.publicUrl,
        publishedAt: created.publishedAt,
      }),
    };
  }
}
