import { createHash } from 'node:crypto';
import type { PublishReceipt } from '../receipt-store.js';
import { receiptProjectId } from '../receipt-store.js';
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

export interface GitHubReleaseDraft {
  tagName: string;
  name: string;
  body: string;
  draft: false;
  prerelease: false;
}

export interface GitHubReleaseRecord {
  id: number;
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
}

export interface GitHubTagReference {
  ref: string;
  sha: string;
  type: 'commit' | 'tag';
}

export interface GitHubReleaseClient {
  findReleaseByTag(repository: string, tagName: string): Promise<GitHubReleaseRecord | null>;
  createRelease(repository: string, input: GitHubReleaseDraft): Promise<GitHubReleaseRecord>;
  deleteRelease(repository: string, releaseId: number): Promise<'deleted' | 'not-found'>;
  findTagReference(repository: string, tagName: string): Promise<GitHubTagReference | null>;
  deleteTagReference(repository: string, tagName: string): Promise<'deleted' | 'not-found'>;
}

const DEFINITION = defineAdapter({
  channel: 'github',
  version: 'github-release@1.3.0',
  capabilities: {
    publish: true,
    status: true,
    metrics: true,
    feedback: true,
    reply: false,
    delete: true,
  },
});

function markerForValues(contentHash: string, idempotencyKey: string, projectId?: string): string {
  const idempotencyHash = createHash('sha256').update(idempotencyKey).digest('hex');
  return projectId
    ? `<!-- marketing-ops:v2 project=${projectId} content-sha256=${contentHash} idempotency-sha256=${idempotencyHash} -->`
    : `<!-- marketing-ops:v1 content-sha256=${contentHash} idempotency-sha256=${idempotencyHash} -->`;
}

function markerFor(input: AdapterPublishInput): string {
  return markerForValues(input.contentHash, input.idempotencyKey, input.projectId);
}

function heading(locale: 'zh-CN' | 'en'): string {
  return locale === 'zh-CN' ? '中文' : 'English';
}

export function buildGitHubReleaseDraft(value: unknown): GitHubReleaseDraft {
  const input = parseAdapterPublishInput(value, {
    channel: 'github',
    format: 'release',
    allowUnresolvedMedia: false,
  });
  const sections = input.package.variants.map(
    (variant) => `## ${heading(variant.locale)}\n\n### ${variant.title}\n\n${variant.body}`,
  );
  return {
    tagName: `marketing/${input.projectId}/${input.campaignId}`,
    name: input.package.variants.map((variant) => variant.title).join(' / '),
    body: `${markerFor(input)}\n\n${sections.join('\n\n')}`,
    draft: false,
    prerelease: false,
  };
}

interface GitHubReleaseAdapterOptions {
  client: GitHubReleaseClient;
  repository: string;
}

function validateRepository(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new AdapterError('INVALID_CONTENT', 'GitHub repository must be owner/name', {
      retryable: false,
    });
  }
  return value;
}

export class GitHubReleaseAdapter implements ChannelAdapter {
  readonly definition = DEFINITION;
  readonly expectedFormat = 'release' as const;
  readonly #client: GitHubReleaseClient;
  readonly #repository: string;

  constructor(options: GitHubReleaseAdapterOptions) {
    this.#client = options.client;
    this.#repository = validateRepository(options.repository);
  }

  async preflight(value: AdapterPublishInput): Promise<void> {
    requireAdapterCapability(this.definition, 'publish');
    parseAdapterPublishInput(value, {
      channel: 'github',
      format: this.expectedFormat,
      allowUnresolvedMedia: false,
    });
  }

  async publish(value: AdapterPublishInput): Promise<AdapterPublishResult> {
    await this.preflight(value);
    const input = parseAdapterPublishInput(value, {
      channel: 'github',
      format: this.expectedFormat,
      allowUnresolvedMedia: false,
    });
    const release = buildGitHubReleaseDraft(input);
    let existing: GitHubReleaseRecord | null;
    try {
      existing = await this.#client.findReleaseByTag(this.#repository, release.tagName);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    if (existing) {
      if (!existing.body.includes(markerFor(input))) {
        throw new AdapterError(
          'IDEMPOTENCY_CONFLICT',
          'The campaign tag already points to different release content',
          { retryable: false },
        );
      }
      return { receipt: this.#toReceipt(input, existing), reused: true };
    }

    let existingTag: GitHubTagReference | null;
    try {
      existingTag = await this.#client.findTagReference(this.#repository, release.tagName);
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
    if (existingTag) {
      throw new AdapterError(
        'IDEMPOTENCY_CONFLICT',
        'The campaign tag exists without an owned Release marker',
        { retryable: false },
      );
    }

    try {
      const created = await this.#client.createRelease(this.#repository, release);
      if (created.tagName !== release.tagName || !created.body.includes(markerFor(input))) {
        throw new AdapterError(
          'UNKNOWN_RESULT',
          'GitHub returned an unexpected release; lookup is required before retry',
          { retryable: false, stage: 'after-submit', lookupRequired: true },
        );
      }
      return { receipt: this.#toReceipt(input, created), reused: false };
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
  }

  async delete(receipt: PublishReceipt): Promise<{ status: 'deleted' | 'already-deleted' }> {
    requireAdapterCapability(this.definition, 'delete');
    const releaseId = Number(receipt.postId);
    const projectId = receiptProjectId(receipt);
    const tagName =
      receipt.schemaVersion === 1
        ? `marketing/${receipt.campaignId}`
        : `marketing/${projectId}/${receipt.campaignId}`;
    const expectedPrefix = `https://github.com/${this.#repository}/releases/`;
    if (
      receipt.channel !== 'github' ||
      !Number.isSafeInteger(releaseId) ||
      releaseId <= 0 ||
      !/^marketing\/(?:[a-z0-9][a-z0-9-]{0,62}\/)?[a-z0-9][a-z0-9._-]{0,63}$/.test(tagName) ||
      !receipt.publicUrl.startsWith(expectedPrefix)
    ) {
      throw new AdapterError(
        'INVALID_CONTENT',
        'Receipt does not identify a known GitHub release',
        {
          retryable: false,
        },
      );
    }
    try {
      const release = await this.#client.findReleaseByTag(this.#repository, tagName);
      if (
        release &&
        (release.id !== releaseId ||
          release.htmlUrl !== receipt.publicUrl ||
          !release.body.includes(
            markerForValues(
              receipt.contentHash,
              receipt.idempotencyKey,
              receipt.schemaVersion === 2 ? projectId : undefined,
            ),
          ))
      ) {
        throw new AdapterError(
          'IDEMPOTENCY_CONFLICT',
          'The campaign tag no longer matches the known Release receipt',
          { retryable: false },
        );
      }
      const releaseResult = release
        ? await this.#client.deleteRelease(this.#repository, releaseId)
        : 'not-found';
      const tagResult = await this.#client.deleteTagReference(this.#repository, tagName);
      return {
        status:
          releaseResult === 'deleted' || tagResult === 'deleted' ? 'deleted' : 'already-deleted',
      };
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
  }

  #toReceipt(input: AdapterPublishInput, release: GitHubReleaseRecord): PublishReceipt {
    const expectedPrefix = `https://github.com/${this.#repository}/releases/`;
    if (!release.htmlUrl.startsWith(expectedPrefix)) {
      throw new AdapterError(
        'UNKNOWN_RESULT',
        'GitHub returned a release URL outside the configured repository',
        { retryable: false, stage: 'after-submit', lookupRequired: true },
      );
    }
    return createPublishedReceipt(input, this.definition.version, {
      postId: String(release.id),
      publicUrl: release.htmlUrl,
      publishedAt: release.publishedAt,
    });
  }
}
