import { createHash } from 'node:crypto';
import { TOOL_INPUT_SCHEMAS, type ChannelId, type PublishCampaignInput } from './contract.js';
import type { PublishReceipt } from './receipt-store.js';
import { receiptProjectId } from './receipt-store.js';
import { assertProjectPublishRequest } from './project-policy.js';
import type { ProjectProfile } from './project-profile-store.js';
import {
  AdapterError,
  type AdapterErrorCode,
  type AdapterPublishInput,
  type ChannelAdapter,
} from './adapters/contract.js';

export interface AdapterRegistration {
  adapter: ChannelAdapter;
  enabled: boolean;
  health: 'ready' | 'not-configured' | 'reauth-required' | 'blocked';
}

export interface ReceiptRepository {
  getByIdempotencyKey(idempotencyKey: string): Promise<PublishReceipt | null>;
  save(receipt: PublishReceipt): Promise<{ receipt: PublishReceipt; reused: boolean }>;
}

export interface PublishFailure {
  channel: ChannelId;
  code: AdapterErrorCode;
  message: string;
  retryable: boolean;
  stage?: 'before-submit' | 'after-submit';
  retryAfterSeconds?: number;
  lookupRequired?: boolean;
}

export interface PublishServiceResult {
  projectId: string;
  campaignId: string;
  receipts: PublishReceipt[];
  failures: PublishFailure[];
}

interface PublishServiceOptions {
  profile: ProjectProfile;
  registrations: AdapterRegistration[];
  receipts: ReceiptRepository;
}

interface PreparedPublication {
  channel: ChannelId;
  registration: AdapterRegistration;
  input: AdapterPublishInput;
}

export function packageHash(value: PublishCampaignInput['packages'][number]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function channelIdempotencyKey(request: PublishCampaignInput, channel: ChannelId): string {
  const digest = createHash('sha256').update(request.idempotencyKey).digest('hex').slice(0, 32);
  return `campaign-v3/${request.projectId}/${request.campaignId}/${channel}/${digest}`;
}

function asFailure(channel: ChannelId, error: unknown): PublishFailure {
  if (error instanceof AdapterError) {
    return {
      channel,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.stage ? { stage: error.stage } : {}),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.lookupRequired ? { lookupRequired: true } : {}),
    };
  }
  return {
    channel,
    code: 'ADAPTER_UNAVAILABLE',
    message: 'Adapter preflight failed',
    retryable: false,
  };
}

function assertReceiptMatches(input: AdapterPublishInput, receipt: PublishReceipt): void {
  if (
    receipt.schemaVersion !== 2 ||
    receiptProjectId(receipt) !== input.projectId ||
    receipt.campaignId !== input.campaignId ||
    receipt.channel !== input.package.channel ||
    receipt.idempotencyKey !== input.idempotencyKey ||
    receipt.contentHash !== input.contentHash
  ) {
    throw new AdapterError(
      'UNKNOWN_RESULT',
      'Adapter receipt does not match the publication request',
      { retryable: false, stage: 'after-submit', lookupRequired: true },
    );
  }
}

export class PublishService {
  readonly #registrations: ReadonlyMap<ChannelId, AdapterRegistration>;
  readonly #receipts: ReceiptRepository;
  readonly #profile: ProjectProfile;

  constructor(options: PublishServiceOptions) {
    const entries = options.registrations.map(
      (registration) => [registration.adapter.definition.channel, registration] as const,
    );
    if (new Set(entries.map(([channel]) => channel)).size !== entries.length) {
      throw new AdapterError('INVALID_CONTENT', 'Adapter registrations must be unique', {
        retryable: false,
      });
    }
    this.#registrations = new Map(entries);
    this.#receipts = options.receipts;
    this.#profile = options.profile;
  }

  async publish(value: unknown): Promise<PublishServiceResult> {
    const request = TOOL_INPUT_SCHEMAS.publish_campaign.parse(value);
    assertProjectPublishRequest(this.#profile, request);
    const receipts: PublishReceipt[] = [];
    const failures: PublishFailure[] = [];
    const prepared: PreparedPublication[] = [];

    for (const packageValue of request.packages) {
      const channel = packageValue.channel;
      const idempotencyKey = channelIdempotencyKey(request, channel);
      const contentHash = packageHash(packageValue);
      const input: AdapterPublishInput = {
        projectId: request.projectId,
        campaignId: request.campaignId,
        idempotencyKey,
        contentHash,
        package: packageValue,
      };
      const existing = await this.#receipts.getByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.contentHash === contentHash) {
          try {
            assertReceiptMatches(input, existing);
            receipts.push(existing);
          } catch (error) {
            failures.push(asFailure(channel, error));
          }
        } else {
          failures.push({
            channel,
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'Idempotency key already belongs to different content',
            retryable: false,
          });
        }
        continue;
      }
      const registration = this.#registrations.get(channel);
      if (!registration || !registration.enabled || registration.health !== 'ready') {
        failures.push({
          channel,
          code: 'ADAPTER_UNAVAILABLE',
          message: 'Adapter is not enabled and ready',
          retryable: false,
        });
        continue;
      }
      try {
        await registration.adapter.preflight(input);
        prepared.push({ channel, registration, input });
      } catch (error) {
        failures.push(asFailure(channel, error));
      }
    }

    if (request.spec.failureMode === 'all-or-none' && failures.length > 0) {
      throw new AdapterError('PREFLIGHT_FAILED', 'At least one channel failed preflight', {
        retryable: false,
      });
    }

    for (const item of prepared) {
      try {
        const result = await item.registration.adapter.publish(item.input);
        assertReceiptMatches(item.input, result.receipt);
        const stored = await this.#receipts.save(result.receipt);
        assertReceiptMatches(item.input, stored.receipt);
        receipts.push(stored.receipt);
      } catch (error) {
        failures.push(asFailure(item.channel, error));
        if (request.spec.failureMode === 'all-or-none') break;
      }
    }

    return {
      projectId: request.projectId,
      campaignId: request.campaignId,
      receipts,
      failures,
    };
  }
}
