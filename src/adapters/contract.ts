import { z } from 'zod';
import {
  CHANNEL_IDS,
  RENDERED_PACKAGE_SCHEMA,
  type ChannelId,
  type RenderedChannelPackage,
} from '../contract.js';
import type { PublishReceipt } from '../receipt-store.js';

export type AdapterOperation = 'publish' | 'status' | 'metrics' | 'feedback' | 'reply' | 'delete';
export type AdapterStage = 'before-submit' | 'after-submit';
export type AdapterErrorCode =
  | 'ADAPTER_UNAVAILABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CONTENT'
  | 'PERMISSION_DENIED'
  | 'PREFLIGHT_FAILED'
  | 'RATE_LIMITED'
  | 'REAUTH_REQUIRED'
  | 'TEMPORARY_FAILURE'
  | 'UNKNOWN_RESULT'
  | 'UNRESOLVED_MEDIA'
  | 'UNSUPPORTED_OPERATION';

export interface AdapterCapabilities {
  publish: boolean;
  status: boolean;
  metrics: boolean;
  feedback: boolean;
  reply: boolean;
  delete: boolean;
}

export interface AdapterDefinition {
  channel: ChannelId;
  version: string;
  capabilities: AdapterCapabilities;
}

export interface AdapterPublishInput {
  projectId: string;
  campaignId: string;
  idempotencyKey: string;
  contentHash: string;
  package: RenderedChannelPackage;
}

export interface AdapterPublishResult {
  receipt: PublishReceipt;
  reused: boolean;
}

export interface ChannelAdapter {
  definition: AdapterDefinition;
  expectedFormat: RenderedChannelPackage['format'];
  preflight(input: AdapterPublishInput): Promise<void>;
  publish(input: AdapterPublishInput): Promise<AdapterPublishResult>;
  delete?(receipt: PublishReceipt): Promise<{ status: 'deleted' | 'already-deleted' }>;
}

interface AdapterErrorOptions {
  retryable: boolean;
  stage?: AdapterStage;
  retryAfterSeconds?: number;
  lookupRequired?: boolean;
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly stage: AdapterStage | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly lookupRequired: boolean | undefined;

  constructor(code: AdapterErrorCode, message: string, options: AdapterErrorOptions) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.retryable = options.retryable;
    this.stage = options.stage;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.lookupRequired = options.lookupRequired;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.stage ? { stage: this.stage } : {}),
      ...(this.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: this.retryAfterSeconds }),
      ...(this.lookupRequired ? { lookupRequired: true } : {}),
    };
  }
}

interface AdapterTransportErrorOptions {
  status?: number;
  timeout?: boolean;
  stage: AdapterStage;
  retryAfterSeconds?: number;
}

export class AdapterTransportError extends Error {
  readonly status: number | undefined;
  readonly timeout: boolean;
  readonly stage: AdapterStage;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, options: AdapterTransportErrorOptions) {
    super(message);
    this.name = 'AdapterTransportError';
    this.status = options.status;
    this.timeout = options.timeout ?? false;
    this.stage = options.stage;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

const definitionSchema = z
  .object({
    channel: z.enum(CHANNEL_IDS),
    version: z.string().regex(/^[a-z0-9-]+@\d+\.\d+\.\d+$/),
    capabilities: z
      .object({
        publish: z.boolean(),
        status: z.boolean(),
        metrics: z.boolean(),
        feedback: z.boolean(),
        reply: z.boolean(),
        delete: z.boolean(),
      })
      .strict(),
  })
  .strict();

const adapterPublishInputSchema = z
  .object({
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    campaignId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    idempotencyKey: z.string().regex(/^[a-z0-9][a-z0-9._/-]{7,255}$/),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    package: RENDERED_PACKAGE_SCHEMA,
  })
  .strict();

export function defineAdapter<T extends AdapterDefinition>(definition: T): T {
  definitionSchema.parse(definition);
  return Object.freeze({
    ...definition,
    capabilities: Object.freeze({ ...definition.capabilities }),
  }) as T;
}

export function requireAdapterCapability(
  definition: AdapterDefinition,
  operation: AdapterOperation,
): void {
  if (!definition.capabilities[operation]) {
    throw new AdapterError(
      'UNSUPPORTED_OPERATION',
      `${definition.channel} does not support ${operation}`,
      { retryable: false },
    );
  }
}

interface AdapterInputConstraints {
  channel: ChannelId;
  format: RenderedChannelPackage['format'];
  allowUnresolvedMedia?: boolean;
}

export function parseAdapterPublishInput(
  value: unknown,
  constraints: AdapterInputConstraints,
): AdapterPublishInput {
  const parsed = adapterPublishInputSchema.parse(value);
  if (parsed.package.channel !== constraints.channel) {
    throw new AdapterError('INVALID_CONTENT', 'Package channel does not match adapter channel', {
      retryable: false,
    });
  }
  if (parsed.package.format !== constraints.format) {
    throw new AdapterError('INVALID_CONTENT', 'Package format does not match adapter format', {
      retryable: false,
    });
  }
  if (
    constraints.allowUnresolvedMedia === false &&
    parsed.package.variants.some((variant) => variant.media.length > 0)
  ) {
    throw new AdapterError(
      'UNRESOLVED_MEDIA',
      'Media types require validated asset references before publishing',
      { retryable: false },
    );
  }
  return parsed;
}

interface PublishedReference {
  postId: string;
  publicUrl: string;
  publishedAt: string;
}

export function createPublishedReceipt(
  input: AdapterPublishInput,
  adapterVersion: string,
  reference: PublishedReference,
): PublishReceipt {
  if (!reference.postId || !reference.publicUrl.startsWith('https://')) {
    throw new AdapterError('UNKNOWN_RESULT', 'Adapter returned an invalid public reference', {
      retryable: false,
      stage: 'after-submit',
      lookupRequired: true,
    });
  }
  if (Number.isNaN(Date.parse(reference.publishedAt))) {
    throw new AdapterError('UNKNOWN_RESULT', 'Adapter returned an invalid publication time', {
      retryable: false,
      stage: 'after-submit',
      lookupRequired: true,
    });
  }
  return {
    schemaVersion: 2,
    projectId: input.projectId,
    campaignId: input.campaignId,
    channel: input.package.channel,
    postId: reference.postId,
    publicUrl: reference.publicUrl,
    publishedAt: reference.publishedAt,
    contentHash: input.contentHash,
    idempotencyKey: input.idempotencyKey,
    adapterVersion,
    status: 'published',
  };
}

function boundedRetryAfter(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 60;
  return Math.min(86_400, Math.max(1, Math.trunc(value)));
}

export function mapAdapterTransportError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  if (!(error instanceof AdapterTransportError)) {
    return new AdapterError('TEMPORARY_FAILURE', 'Adapter transport failed', {
      retryable: true,
      stage: 'before-submit',
    });
  }
  if (error.stage === 'after-submit' && (error.timeout || (error.status ?? 0) >= 500)) {
    return new AdapterError(
      'UNKNOWN_RESULT',
      'Publication outcome is unknown; lookup is required before retry',
      { retryable: false, stage: error.stage, lookupRequired: true },
    );
  }
  if (error.status === 401) {
    return new AdapterError('REAUTH_REQUIRED', 'Channel authorization must be renewed', {
      retryable: false,
      stage: error.stage,
    });
  }
  if (error.status === 403) {
    return new AdapterError('PERMISSION_DENIED', 'Channel permission was denied', {
      retryable: false,
      stage: error.stage,
    });
  }
  if (error.status === 429) {
    return new AdapterError('RATE_LIMITED', 'Channel rate limit was reached', {
      retryable: true,
      stage: error.stage,
      retryAfterSeconds: boundedRetryAfter(error.retryAfterSeconds),
    });
  }
  if (error.timeout || (error.status ?? 0) >= 500) {
    return new AdapterError('TEMPORARY_FAILURE', 'Channel is temporarily unavailable', {
      retryable: true,
      stage: error.stage,
    });
  }
  return new AdapterError('TEMPORARY_FAILURE', 'Adapter transport failed', {
    retryable: true,
    stage: error.stage,
  });
}
