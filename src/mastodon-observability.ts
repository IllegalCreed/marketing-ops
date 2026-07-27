import { AdapterError, mapAdapterTransportError } from './adapters/contract.js';
import { MarketingOpsError } from './errors.js';
import type { PublicPostRef, PublishReceipt } from './receipt-store.js';
import type { MastodonNotificationRecord, MastodonStatusRecord } from './adapters/mastodon-api.js';

export type { MastodonNotificationRecord } from './adapters/mastodon-api.js';

export interface MastodonObservabilityClient {
  getStatus(statusId: string): Promise<MastodonStatusRecord>;
  listNotifications(): Promise<MastodonNotificationRecord[]>;
}

function validatePostRef(postRef: PublicPostRef): string {
  if (
    postRef.channel !== 'mastodon' ||
    !/^[1-9]\d{0,63}$/.test(postRef.postId) ||
    !postRef.publicUrl.startsWith('https://')
  ) {
    throw new MarketingOpsError('INVALID_INPUT', 'Mastodon collector requires a Mastodon status');
  }
  return postRef.postId;
}

async function readPlatform<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof MarketingOpsError || error instanceof AdapterError) throw error;
    throw mapAdapterTransportError(error);
  }
}

function assertStatus(record: MastodonStatusRecord, postId: string, publicUrl: string): void {
  if (record.id !== postId || record.publicUrl !== publicUrl) {
    throw new AdapterError('UNKNOWN_RESULT', 'Mastodon status does not match the receipt', {
      retryable: false,
      stage: 'before-submit',
      lookupRequired: true,
    });
  }
}

export class MastodonCollector {
  readonly #client: MastodonObservabilityClient;
  readonly #now: () => string;

  constructor(options: { client: MastodonObservabilityClient; now?: () => string }) {
    this.#client = options.client;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async collect(receipt: PublishReceipt) {
    if (receipt.channel !== 'mastodon' || receipt.status !== 'published') {
      throw new MarketingOpsError('INVALID_INPUT', 'Receipt is not a published Mastodon status');
    }
    const postId = validatePostRef(receipt);
    const status = await readPlatform(() => this.#client.getStatus(postId));
    assertStatus(status, postId, receipt.publicUrl);
    return {
      schemaVersion: 1 as const,
      channel: 'mastodon' as const,
      scope: 'post-lifetime' as const,
      attribution: 'post-level' as const,
      collectedAt: this.#now(),
      status: {
        postId: status.id,
        publicUrl: status.publicUrl,
        publishedAt: status.publishedAt,
        favourites: status.favouriteCount,
        reblogs: status.reblogCount,
        replies: status.replyCount,
      },
      limitations: ['instance-level-notifications-may-hide-filtered-events'],
    };
  }

  async listFeedback(postRef: PublicPostRef) {
    const postId = validatePostRef(postRef);
    const notifications = await readPlatform(() => this.#client.listNotifications());
    const items = notifications
      .filter(
        (notification) =>
          notification.statusId === postId && notification.statusUrl === postRef.publicUrl,
      )
      .map((notification) => ({
        id: `mastodon-notification:${notification.id}`,
        kind: notification.type,
        authorAlias: notification.authorAlias,
        body: notification.bodyHtml,
        createdAt: notification.createdAt,
        sourceUrl: notification.statusUrl,
        untrusted: true as const,
      }));
    return { items, nextCursor: null, truncated: false };
  }
}
