import {
  ASSISTED_CHANNEL_IDS,
  TOOL_INPUT_SCHEMAS,
  type ChannelId,
  type PublishCampaignInput,
} from './contract.js';
import { MarketingOpsError } from './errors.js';
import { channelIdempotencyKey, packageHash, type ReceiptRepository } from './publish-service.js';
import { receiptProjectId, type PublicPostRef, type PublishReceipt } from './receipt-store.js';

export const ASSISTED_ADAPTER_VERSION = 'assisted-owner-confirmed@1.0.0';
type AssistedChannelId = (typeof ASSISTED_CHANNEL_IDS)[number];

export interface AssistedReceiptRepository extends ReceiptRepository {
  findKnownPostRef(projectId: string, postRef: PublicPostRef): Promise<PublishReceipt | null>;
}

interface AssistedPublicationServiceOptions {
  receipts: AssistedReceiptRepository;
  now?: () => string;
}

interface ExtractedReference {
  postId: string;
  publicUrl: string;
}

interface PreparedConfirmation {
  channel: AssistedChannelId;
  contentHash: string;
  idempotencyKey: string;
  reference: ExtractedReference;
  receipt: PublishReceipt;
}

function invalidReference(): never {
  throw new MarketingOpsError(
    'INVALID_INPUT',
    'Public URL does not match the assisted publication channel',
  );
}

function pathMatch(url: URL, pattern: RegExp): string {
  return pattern.exec(url.pathname)?.[1] ?? invalidReference();
}

function queryValue(url: URL, key: string, pattern: RegExp): string {
  const value = url.searchParams.get(key);
  return value && pattern.test(value) ? value : invalidReference();
}

function assertHost(url: URL, hosts: readonly string[]): void {
  if (!hosts.includes(url.hostname.toLowerCase())) invalidReference();
}

function safePublicUrl(value: string): URL {
  if (value.length > 2_048) invalidReference();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidReference();
  }
  if (url.protocol !== 'https:' || url.username || url.password) invalidReference();
  return url;
}

export function extractAssistedPostId(channel: AssistedChannelId, value: string): string {
  const url = safePublicUrl(value);
  switch (channel) {
    case 'v2ex':
      assertHost(url, ['v2ex.com', 'www.v2ex.com']);
      return pathMatch(url, /^\/t\/(\d+)\/?$/);
    case 'hacker-news':
      assertHost(url, ['news.ycombinator.com']);
      if (url.pathname !== '/item') invalidReference();
      return queryValue(url, 'id', /^\d+$/);
    case 'product-hunt':
      assertHost(url, ['producthunt.com', 'www.producthunt.com']);
      return pathMatch(url, /^\/posts\/([a-z0-9][a-z0-9-]{0,99})\/?$/i);
    case 'juejin':
      assertHost(url, ['juejin.cn']);
      return pathMatch(url, /^\/post\/(\d+)\/?$/);
    case 'bilibili':
      assertHost(url, ['bilibili.com', 'www.bilibili.com']);
      return pathMatch(url, /^\/video\/((?:BV[0-9A-Za-z]+)|(?:av\d+))\/?$/);
    case 'zhihu':
      if (url.hostname === 'zhuanlan.zhihu.com') {
        return pathMatch(url, /^\/p\/(\d+)\/?$/);
      }
      assertHost(url, ['zhihu.com', 'www.zhihu.com']);
      return pathMatch(url, /^\/question\/\d+\/answer\/(\d+)\/?$/);
    case 'x':
      assertHost(url, ['x.com', 'www.x.com']);
      return pathMatch(url, /^\/[^/]+\/status\/(\d+)\/?$/);
    case 'jianshu':
      assertHost(url, ['jianshu.com', 'www.jianshu.com']);
      return pathMatch(url, /^\/p\/([0-9A-Za-z]+)\/?$/);
    case 'facebook':
      assertHost(url, ['facebook.com', 'www.facebook.com', 'm.facebook.com']);
      if (url.pathname === '/permalink.php') {
        return queryValue(url, 'story_fbid', /^[0-9A-Za-z]+$/);
      }
      return pathMatch(url, /^\/(?:[^/]+\/posts|share\/p|reel|watch)\/([0-9A-Za-z._-]+)\/?$/);
    case 'youtube':
      if (url.hostname === 'youtu.be') {
        return pathMatch(url, /^\/([0-9A-Za-z_-]{6,64})\/?$/);
      }
      assertHost(url, ['youtube.com', 'www.youtube.com', 'm.youtube.com']);
      if (url.pathname === '/watch') {
        return queryValue(url, 'v', /^[0-9A-Za-z_-]{6,64}$/);
      }
      return pathMatch(url, /^\/(?:shorts|live)\/([0-9A-Za-z_-]{6,64})\/?$/);
    case 'douyin':
      assertHost(url, ['douyin.com', 'www.douyin.com']);
      return pathMatch(url, /^\/video\/(\d+)\/?$/);
    case 'weibo':
      assertHost(url, ['weibo.com', 'www.weibo.com']);
      return pathMatch(url, /^\/\d+\/([0-9A-Za-z]+)\/?$/);
  }
}

function assertReceipt(
  receipt: PublishReceipt,
  request: PublishCampaignInput,
  channel: ChannelId,
  idempotencyKey: string,
  contentHash: string,
  reference: ExtractedReference,
): void {
  if (
    receipt.schemaVersion !== 2 ||
    receiptProjectId(receipt) !== request.projectId ||
    receipt.campaignId !== request.campaignId ||
    receipt.channel !== channel ||
    receipt.idempotencyKey !== idempotencyKey ||
    receipt.contentHash !== contentHash ||
    receipt.postId !== reference.postId ||
    receipt.publicUrl !== reference.publicUrl ||
    receipt.adapterVersion !== ASSISTED_ADAPTER_VERSION ||
    receipt.status !== 'published'
  ) {
    throw new MarketingOpsError(
      'INVALID_INPUT',
      'Assisted publication conflicts with an existing receipt',
    );
  }
}

function confirmationTime(now: () => string): string {
  const value = now();
  if (Number.isNaN(Date.parse(value))) {
    throw new MarketingOpsError('INVALID_INPUT', 'Confirmation time is invalid');
  }
  return new Date(value).toISOString();
}

export class AssistedPublicationService {
  readonly #receipts: AssistedReceiptRepository;
  readonly #now: () => string;

  constructor(options: AssistedPublicationServiceOptions) {
    this.#receipts = options.receipts;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async execute(value: unknown) {
    const request = TOOL_INPUT_SCHEMAS.publish_campaign.parse(value);
    if (request.execution.mode === 'automatic') {
      throw new MarketingOpsError(
        'INVALID_INPUT',
        'Automatic publication cannot use the assisted service',
      );
    }
    const confirmations =
      request.execution.mode === 'assisted-confirm'
        ? new Map(
            request.execution.confirmations.map((confirmation) => [
              confirmation.channel,
              confirmation.publicUrl,
            ]),
          )
        : null;
    const receipts: PublishReceipt[] = [];
    const handoffs = [];
    const preparedConfirmations: PreparedConfirmation[] = [];
    const confirmedAt = confirmations ? confirmationTime(this.#now) : null;

    for (const packageValue of request.packages) {
      const channel = packageValue.channel as AssistedChannelId;
      const contentHash = packageHash(packageValue);
      const idempotencyKey = channelIdempotencyKey(request, channel);
      const publicUrl = confirmations?.get(channel);
      if (!publicUrl) {
        handoffs.push({
          channel,
          status: 'awaiting-owner' as const,
          contentHash,
          idempotencyKey,
          nextAction:
            'Publish this package in the official UI, then confirm its public URL.' as const,
        });
        continue;
      }

      const reference = {
        postId: extractAssistedPostId(channel, publicUrl),
        publicUrl,
      };
      const existing = await this.#receipts.getByIdempotencyKey(idempotencyKey);
      if (existing) {
        assertReceipt(existing, request, channel, idempotencyKey, contentHash, reference);
        receipts.push(existing);
        handoffs.push({
          channel,
          status: 'confirmed' as const,
          contentHash,
          idempotencyKey,
          reused: true,
        });
        continue;
      }
      const knownReference = await this.#receipts.findKnownPostRef(request.projectId, {
        channel,
        ...reference,
      });
      if (knownReference) {
        throw new MarketingOpsError(
          'INVALID_INPUT',
          'Public URL already belongs to another publication receipt',
        );
      }
      preparedConfirmations.push({
        channel,
        contentHash,
        idempotencyKey,
        reference,
        receipt: {
          schemaVersion: 2,
          projectId: request.projectId,
          campaignId: request.campaignId,
          channel,
          ...reference,
          publishedAt: confirmedAt!,
          contentHash,
          idempotencyKey,
          adapterVersion: ASSISTED_ADAPTER_VERSION,
          status: 'published',
        },
      });
    }

    for (const prepared of preparedConfirmations) {
      const stored = await this.#receipts.save(prepared.receipt);
      assertReceipt(
        stored.receipt,
        request,
        prepared.channel,
        prepared.idempotencyKey,
        prepared.contentHash,
        prepared.reference,
      );
      receipts.push(stored.receipt);
      handoffs.push({
        channel: prepared.channel,
        status: 'confirmed' as const,
        contentHash: prepared.contentHash,
        idempotencyKey: prepared.idempotencyKey,
        reused: stored.reused,
      });
    }

    return {
      projectId: request.projectId,
      campaignId: request.campaignId,
      receipts,
      failures: [],
      handoffs,
      limitations: [
        'publication-is-owner-confirmed-not-remotely-created',
        'confirmation-time-is-not-platform-publication-time',
      ],
    };
  }
}
