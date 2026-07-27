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
import type {
  MastodonStatusDraft,
  MastodonStatusLookup,
  MastodonStatusRecord,
} from './mastodon-api.js';

export interface MastodonStatusClient {
  findRecentStatusByText(text: string, accountId: string): Promise<MastodonStatusLookup>;
  createStatus(draft: MastodonStatusDraft): Promise<MastodonStatusRecord>;
  deleteStatus(statusId: string): Promise<{ status: 'deleted' }>;
}

const DEFINITION = defineAdapter({
  channel: 'mastodon',
  version: 'mastodon-status@0.1.0',
  capabilities: {
    publish: true,
    status: true,
    metrics: true,
    feedback: true,
    reply: false,
    delete: true,
  },
});

const recordSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d{0,63}$/),
    uri: z.string().url(),
    text: z.string().min(1).max(100_000),
    publicUrl: z.string().url(),
    publishedAt: z.iso.datetime({ offset: true }),
    replyCount: z.number().int().nonnegative().safe(),
    reblogCount: z.number().int().nonnegative().safe(),
    favouriteCount: z.number().int().nonnegative().safe(),
  })
  .strict();
const deleteReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.literal('mastodon'),
    postId: z.string().regex(/^[1-9]\d{0,63}$/),
    publicUrl: z.string().url(),
    adapterVersion: z.literal(DEFINITION.version),
    status: z.literal('published'),
  })
  .passthrough();

function parseInput(value: unknown): AdapterPublishInput {
  const input = parseAdapterPublishInput(value, {
    channel: 'mastodon',
    format: 'status',
    allowUnresolvedMedia: false,
  });
  if (input.package.variants.length !== 1) {
    throw new AdapterError('INVALID_CONTENT', 'Mastodon status requires one locale variant', {
      retryable: false,
    });
  }
  const variant = input.package.variants[0]!;
  if (!['en', 'zh-CN'].includes(variant.locale)) {
    throw new AdapterError('INVALID_CONTENT', 'Mastodon locale is invalid', {
      retryable: false,
    });
  }
  const graphemes = [
    ...new Intl.Segmenter(variant.locale, { granularity: 'grapheme' }).segment(variant.body),
  ].length;
  if (graphemes > 500 || variant.links.some((link) => !variant.body.includes(link))) {
    throw new AdapterError(
      'INVALID_CONTENT',
      'Mastodon text must preserve renderer links and stay within 500 graphemes',
      { retryable: false },
    );
  }
  return input;
}

function buildDraft(value: unknown): MastodonStatusDraft {
  const input = parseInput(value);
  const variant = input.package.variants[0]!;
  return {
    text: variant.body,
    visibility: 'public',
    language: variant.locale === 'zh-CN' ? 'zh' : 'en',
    idempotencyKey: input.idempotencyKey,
  };
}

function parseRecord(
  value: unknown,
  stage: 'before-submit' | 'after-submit',
): MastodonStatusRecord {
  const parsed = recordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (stage === 'after-submit') {
    throw new AdapterError(
      'UNKNOWN_RESULT',
      'Mastodon returned an invalid status; lookup is required',
      { retryable: false, stage, lookupRequired: true },
    );
  }
  throw new AdapterError('TEMPORARY_FAILURE', 'Mastodon returned an invalid status', {
    retryable: true,
    stage,
  });
}

function assertStatusText(
  record: MastodonStatusRecord,
  text: string,
  stage: 'before-submit' | 'after-submit',
): void {
  if (record.text === text) return;
  throw new AdapterError(
    stage === 'after-submit' ? 'UNKNOWN_RESULT' : 'IDEMPOTENCY_CONFLICT',
    stage === 'after-submit'
      ? 'Mastodon returned different status content'
      : 'Existing Mastodon status content does not match',
    {
      retryable: false,
      stage,
      ...(stage === 'after-submit' ? { lookupRequired: true } : {}),
    },
  );
}

function parseDeleteReceipt(value: PublishReceipt): string {
  const parsed = deleteReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdapterError('INVALID_CONTENT', 'Mastodon delete receipt is invalid', {
      retryable: false,
    });
  }
  return parsed.data.postId;
}

export class MastodonStatusAdapter implements ChannelAdapter {
  readonly definition = DEFINITION;
  readonly expectedFormat = 'status' as const;
  readonly #client: MastodonStatusClient;
  readonly #accountId: string;

  constructor(options: { client: MastodonStatusClient; accountId?: string }) {
    this.#client = options.client;
    this.#accountId = options.accountId ?? '109876';
  }

  async preflight(value: AdapterPublishInput): Promise<void> {
    requireAdapterCapability(this.definition, 'publish');
    buildDraft(value);
  }

  async publish(value: AdapterPublishInput): Promise<AdapterPublishResult> {
    await this.preflight(value);
    const input = parseInput(value);
    const draft = buildDraft(input);
    let lookup: MastodonStatusLookup;
    try {
      lookup = await this.#client.findRecentStatusByText(draft.text, this.#accountId);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    if (typeof lookup.complete !== 'boolean' || !('status' in lookup)) {
      throw new AdapterError('TEMPORARY_FAILURE', 'Mastodon lookup returned an invalid result', {
        retryable: true,
        stage: 'before-submit',
      });
    }
    if (!lookup.complete) {
      throw new AdapterError('TEMPORARY_FAILURE', 'Mastodon status lookup was incomplete', {
        retryable: true,
        stage: 'before-submit',
      });
    }
    if (lookup.status) {
      const existing = parseRecord(lookup.status, 'before-submit');
      assertStatusText(existing, draft.text, 'before-submit');
      return {
        reused: true,
        receipt: createPublishedReceipt(input, this.definition.version, {
          postId: existing.id,
          publicUrl: existing.publicUrl,
          publishedAt: existing.publishedAt,
        }),
      };
    }
    let createdValue: MastodonStatusRecord;
    try {
      createdValue = await this.#client.createStatus(draft);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    const created = parseRecord(createdValue, 'after-submit');
    assertStatusText(created, draft.text, 'after-submit');
    return {
      reused: false,
      receipt: createPublishedReceipt(input, this.definition.version, {
        postId: created.id,
        publicUrl: created.publicUrl,
        publishedAt: created.publishedAt,
      }),
    };
  }

  async delete(receipt: PublishReceipt): Promise<{ status: 'deleted' }> {
    requireAdapterCapability(this.definition, 'delete');
    const statusId = parseDeleteReceipt(receipt);
    try {
      return await this.#client.deleteStatus(statusId);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
  }
}
