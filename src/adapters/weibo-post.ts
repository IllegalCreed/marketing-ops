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

export interface WeiboTextDraft {
  text: string;
}

export interface WeiboPostRecord {
  id: string;
  text: string;
  publicUrl: string;
  publishedAt: string;
}

export interface WeiboPostLookup {
  complete: boolean;
  post: WeiboPostRecord | null;
}

export interface WeiboTextClient {
  findRecentPostByText(text: string): Promise<WeiboPostLookup>;
  createTextPost(draft: WeiboTextDraft): Promise<WeiboPostRecord>;
}

const DEFINITION = defineAdapter({
  channel: 'weibo',
  version: 'weibo-text@0.1.0',
  capabilities: {
    publish: true,
    status: false,
    metrics: false,
    feedback: false,
    reply: false,
    delete: false,
  },
});

const recordSchema = z
  .object({
    id: z.string().regex(/^\d{6,32}$/),
    text: z.string().min(1).max(10_000),
    publicUrl: z
      .url()
      .refine(
        (url) => url.startsWith('https://weibo.com/') || url.startsWith('https://m.weibo.cn/'),
        'Unsupported Weibo post URL',
      ),
    publishedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

function parseInput(value: unknown): AdapterPublishInput {
  const input = parseAdapterPublishInput(value, {
    channel: 'weibo',
    format: 'post',
    allowUnresolvedMedia: false,
  });
  if (input.package.variants.length !== 1 || input.package.variants[0]?.locale !== 'zh-CN') {
    throw new AdapterError('INVALID_CONTENT', 'Weibo text posts require one Chinese variant', {
      retryable: false,
    });
  }
  const variant = input.package.variants[0];
  const bodyLength = [
    ...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(variant.body),
  ].length;
  if (bodyLength > 2_000 || variant.links.some((link) => !variant.body.includes(link))) {
    throw new AdapterError(
      'INVALID_CONTENT',
      'Weibo text must preserve renderer links and stay within 2000 graphemes',
      { retryable: false },
    );
  }
  return input;
}

export function buildWeiboTextDraft(value: unknown): WeiboTextDraft {
  const input = parseInput(value);
  return { text: input.package.variants[0]!.body };
}

function parseRecord(value: unknown, stage: 'before-submit' | 'after-submit'): WeiboPostRecord {
  const parsed = recordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (stage === 'after-submit') {
    throw new AdapterError('UNKNOWN_RESULT', 'Weibo returned an invalid post; lookup is required', {
      retryable: false,
      stage,
      lookupRequired: true,
    });
  }
  throw new AdapterError('TEMPORARY_FAILURE', 'Weibo returned an invalid post', {
    retryable: true,
    stage,
  });
}

function assertRecordText(
  record: WeiboPostRecord,
  text: string,
  stage: 'before-submit' | 'after-submit',
) {
  if (record.text === text) return;
  if (stage === 'after-submit') {
    throw new AdapterError('UNKNOWN_RESULT', 'Weibo returned different post content', {
      retryable: false,
      stage,
      lookupRequired: true,
    });
  }
  throw new AdapterError('IDEMPOTENCY_CONFLICT', 'Existing Weibo post content does not match', {
    retryable: false,
    stage,
  });
}

export class WeiboTextAdapter implements ChannelAdapter {
  readonly definition = DEFINITION;
  readonly expectedFormat = 'post' as const;
  readonly #client: WeiboTextClient;

  constructor(options: { client: WeiboTextClient }) {
    this.#client = options.client;
  }

  async preflight(value: AdapterPublishInput): Promise<void> {
    requireAdapterCapability(this.definition, 'publish');
    parseInput(value);
  }

  async publish(value: AdapterPublishInput): Promise<AdapterPublishResult> {
    await this.preflight(value);
    const input = parseInput(value);
    const draft = buildWeiboTextDraft(input);
    let lookup: WeiboPostLookup;
    try {
      lookup = await this.#client.findRecentPostByText(draft.text);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    if (typeof lookup.complete !== 'boolean' || !('post' in lookup)) {
      throw new AdapterError('TEMPORARY_FAILURE', 'Weibo lookup returned an invalid result', {
        retryable: true,
        stage: 'before-submit',
      });
    }
    if (!lookup.complete) {
      throw new AdapterError('TEMPORARY_FAILURE', 'Weibo recent-post lookup was incomplete', {
        retryable: true,
        stage: 'before-submit',
      });
    }
    if (lookup.post) {
      const existing = parseRecord(lookup.post, 'before-submit');
      assertRecordText(existing, draft.text, 'before-submit');
      return {
        reused: true,
        receipt: createPublishedReceipt(input, this.definition.version, {
          postId: existing.id,
          publicUrl: existing.publicUrl,
          publishedAt: existing.publishedAt,
        }),
      };
    }

    let createdValue: WeiboPostRecord;
    try {
      createdValue = await this.#client.createTextPost(draft);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    const created = parseRecord(createdValue, 'after-submit');
    assertRecordText(created, draft.text, 'after-submit');
    return {
      reused: false,
      receipt: createPublishedReceipt(input, this.definition.version, {
        postId: created.id,
        publicUrl: created.publicUrl,
        publishedAt: created.publishedAt,
      }),
    };
  }
}
