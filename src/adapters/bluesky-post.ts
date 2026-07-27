import { z } from 'zod';
import type { PublishReceipt } from '../receipt-store.js';
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

export interface BlueskyTextDraft {
  text: string;
  langs: ['en'];
}

export interface BlueskyPostRecord {
  uri: string;
  cid: string;
  text: string;
  publicUrl: string;
  publishedAt: string;
}

export interface BlueskyPostLookup {
  complete: boolean;
  post: BlueskyPostRecord | null;
}

export interface BlueskyTextClient {
  findRecentPostByText(text: string): Promise<BlueskyPostLookup>;
  createTextPost(draft: BlueskyTextDraft): Promise<BlueskyPostRecord>;
  deleteTextPost(uri: string): Promise<{ status: 'deleted' }>;
}

const DEFINITION = defineAdapter({
  channel: 'bluesky',
  version: 'bluesky-text@0.2.0',
  capabilities: {
    publish: true,
    status: false,
    metrics: false,
    feedback: false,
    reply: false,
    delete: true,
  },
});

const atUriPattern =
  /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]+)$/;
const recordSchema = z
  .object({
    uri: z.string().regex(atUriPattern),
    cid: z.string().min(1).max(256),
    text: z.string().min(1).max(3_000),
    publicUrl: z
      .url()
      .refine((url) => url.startsWith('https://bsky.app/profile/'), 'Unsupported Bluesky URL'),
    publishedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const deleteReceiptSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    channel: z.literal('bluesky'),
    postId: z.string().regex(atUriPattern),
    publicUrl: z.url(),
    adapterVersion: z.literal(DEFINITION.version),
    status: z.literal('published'),
  })
  .passthrough();
const deleteResultSchema = z.object({ status: z.literal('deleted') }).strict();

function publicUrlFromUri(uri: string): string {
  const match = atUriPattern.exec(uri)!;
  return `https://bsky.app/profile/${match[1]}/post/${match[2]}`;
}

function parseDeleteReceipt(value: PublishReceipt): string {
  const parsed = deleteReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.publicUrl !== publicUrlFromUri(parsed.data.postId)) {
    throw new AdapterError('INVALID_CONTENT', 'Bluesky delete receipt is invalid', {
      retryable: false,
    });
  }
  return parsed.data.postId;
}

function parseInput(value: unknown): AdapterPublishInput {
  const input = parseAdapterPublishInput(value, {
    channel: 'bluesky',
    format: 'post',
    allowUnresolvedMedia: false,
  });
  if (input.package.variants.length !== 1 || input.package.variants[0]?.locale !== 'en') {
    throw new AdapterError('INVALID_CONTENT', 'Bluesky text posts require one English variant', {
      retryable: false,
    });
  }
  const variant = input.package.variants[0];
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(variant.body)]
    .length;
  if (graphemes > 300 || variant.links.some((link) => !variant.body.includes(link))) {
    throw new AdapterError(
      'INVALID_CONTENT',
      'Bluesky text must preserve renderer links and stay within 300 graphemes',
      { retryable: false },
    );
  }
  return input;
}

export function buildBlueskyTextDraft(value: unknown): BlueskyTextDraft {
  const input = parseInput(value);
  return { text: input.package.variants[0]!.body, langs: ['en'] };
}

function parseRecord(value: unknown, stage: 'before-submit' | 'after-submit'): BlueskyPostRecord {
  const parsed = recordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (stage === 'after-submit') {
    throw new AdapterError(
      'UNKNOWN_RESULT',
      'Bluesky returned an invalid post; lookup is required',
      { retryable: false, stage, lookupRequired: true },
    );
  }
  throw new AdapterError('TEMPORARY_FAILURE', 'Bluesky returned an invalid post', {
    retryable: true,
    stage,
  });
}

function assertRecordText(
  record: BlueskyPostRecord,
  text: string,
  stage: 'before-submit' | 'after-submit',
): void {
  if (record.text === text) return;
  if (stage === 'after-submit') {
    throw new AdapterError('UNKNOWN_RESULT', 'Bluesky returned different post content', {
      retryable: false,
      stage,
      lookupRequired: true,
    });
  }
  throw new AdapterError('IDEMPOTENCY_CONFLICT', 'Existing Bluesky post content does not match', {
    retryable: false,
    stage,
  });
}

export class BlueskyTextAdapter implements ChannelAdapter {
  readonly definition = DEFINITION;
  readonly expectedFormat = 'post' as const;
  readonly #client: BlueskyTextClient;

  constructor(options: { client: BlueskyTextClient }) {
    this.#client = options.client;
  }

  async preflight(value: AdapterPublishInput): Promise<void> {
    requireAdapterCapability(this.definition, 'publish');
    parseInput(value);
  }

  async publish(value: AdapterPublishInput): Promise<AdapterPublishResult> {
    await this.preflight(value);
    const input = parseInput(value);
    const draft = buildBlueskyTextDraft(input);
    let lookup: BlueskyPostLookup;
    try {
      lookup = await this.#client.findRecentPostByText(draft.text);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    if (typeof lookup.complete !== 'boolean' || !('post' in lookup)) {
      throw new AdapterError('TEMPORARY_FAILURE', 'Bluesky lookup returned an invalid result', {
        retryable: true,
        stage: 'before-submit',
      });
    }
    if (!lookup.complete) {
      throw new AdapterError('TEMPORARY_FAILURE', 'Bluesky recent-post lookup was incomplete', {
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
          postId: existing.uri,
          publicUrl: existing.publicUrl,
          publishedAt: existing.publishedAt,
        }),
      };
    }

    let createdValue: BlueskyPostRecord;
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
        postId: created.uri,
        publicUrl: created.publicUrl,
        publishedAt: created.publishedAt,
      }),
    };
  }

  async delete(receipt: PublishReceipt): Promise<{ status: 'deleted' }> {
    requireAdapterCapability(this.definition, 'delete');
    const uri = parseDeleteReceipt(receipt);
    let result: { status: 'deleted' };
    try {
      result = await this.#client.deleteTextPost(uri);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    const parsed = deleteResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new AdapterError('UNKNOWN_RESULT', 'Bluesky delete result is invalid', {
        retryable: false,
        stage: 'after-submit',
        lookupRequired: true,
      });
    }
    return parsed.data;
  }
}
