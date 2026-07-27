import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AdapterError, type ChannelAdapter } from './adapters/contract.js';
import {
  PublishService,
  type AdapterRegistration,
  type ReceiptRepository,
} from './publish-service.js';
import type { ProjectPublishReceipt, PublishReceipt } from './receipt-store.js';
import type { ProjectProfile } from './project-profile-store.js';
import { createGitHubPackage, createPublishRequest, TEST_CONTENT_HASH } from './test-fixtures.js';

const PROJECT_PROFILE: ProjectProfile = {
  schemaVersion: 1,
  id: 'algorithm-visualizer',
  displayName: 'Algorithm Visualizer',
  canonicalOrigins: ['https://algo.illegalscreed.cn'],
  channels: ['github', 'dev'],
  github: { repository: 'IllegalCreed/algorithms-visualization' },
  dev: { tags: ['algorithms', 'webdev', 'opensource'] },
};

function receipt(
  channel: 'github' | 'dev',
  idempotencyKey: string,
  contentHash = TEST_CONTENT_HASH,
): ProjectPublishReceipt {
  return {
    schemaVersion: 2,
    projectId: 'algorithm-visualizer',
    campaignId: 'quick-sort-launch',
    channel,
    postId: `${channel}-1`,
    publicUrl:
      channel === 'github'
        ? 'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Fquick-sort-launch'
        : 'https://dev.to/illegalcreed/quick-sort-launch',
    publishedAt: '2026-07-11T00:00:00.000Z',
    contentHash,
    idempotencyKey,
    adapterVersion: `${channel}@1.0.0`,
    status: 'published',
  };
}

function fakeAdapter(channel: 'github' | 'dev', format: 'release' | 'article') {
  const adapter: ChannelAdapter = {
    definition: {
      channel,
      version: `${channel}@1.0.0`,
      capabilities: {
        publish: true,
        status: true,
        metrics: false,
        feedback: false,
        reply: false,
        delete: false,
      },
    },
    expectedFormat: format,
    preflight: vi.fn(async () => undefined),
    publish: vi.fn(async (input) => ({
      receipt: receipt(channel, input.idempotencyKey, input.contentHash),
      reused: false,
    })),
  };
  return adapter;
}

class MemoryReceipts implements ReceiptRepository {
  readonly values = new Map<string, PublishReceipt>();
  readonly events: string[] = [];

  async getByIdempotencyKey(key: string) {
    this.events.push(`get:${key}`);
    return this.values.get(key) ?? null;
  }

  async save(value: PublishReceipt) {
    this.events.push(`save:${value.idempotencyKey}`);
    const existing = this.values.get(value.idempotencyKey);
    if (existing) return { receipt: existing, reused: true };
    this.values.set(value.idempotencyKey, value);
    return { receipt: value, reused: false };
  }
}

function registration(adapter: ChannelAdapter, overrides: Partial<AdapterRegistration> = {}) {
  return {
    adapter,
    enabled: true,
    health: 'ready' as const,
    ...overrides,
  };
}

function requestWithGitHubAndDev(failureMode: 'all-or-none' | 'continue-supported') {
  const base = createPublishRequest();
  return {
    ...base,
    spec: {
      ...base.spec,
      channels: ['github', 'dev'] as const,
      failureMode,
    },
    packages: [
      createGitHubPackage(),
      {
        ...createGitHubPackage(),
        channel: 'dev' as const,
        format: 'article' as const,
        canonicalUrl: 'https://algo.illegalscreed.cn/en/docs/quick-sort/',
        variants: [createGitHubPackage().variants[1]],
      },
    ],
  };
}

describe('publish service dispatch boundary', () => {
  it('TC-AUTO-DISPATCH-127-01 只调用注册、启用且健康的精确 adapter', async () => {
    const github = fakeAdapter('github', 'release');
    const service = new PublishService({
      profile: PROJECT_PROFILE,
      registrations: [registration(github)],
      receipts: new MemoryReceipts(),
    });

    await expect(service.publish(createPublishRequest())).resolves.toMatchObject({
      receipts: [{ channel: 'github' }],
      failures: [],
    });
    expect(github.publish).toHaveBeenCalledOnce();

    const disabled = new PublishService({
      profile: PROJECT_PROFILE,
      registrations: [registration(github, { enabled: false })],
      receipts: new MemoryReceipts(),
    });
    await expect(disabled.publish(createPublishRequest())).resolves.toMatchObject({
      receipts: [],
      failures: [{ channel: 'github', code: 'ADAPTER_UNAVAILABLE' }],
    });

    expect(
      () =>
        new PublishService({
          profile: PROJECT_PROFILE,
          registrations: [registration(github), registration(github)],
          receipts: new MemoryReceipts(),
        }),
    ).toThrow(/unique/i);

    vi.mocked(github.preflight).mockRejectedValueOnce(new Error('unexpected failure'));
    await expect(
      new PublishService({
        profile: PROJECT_PROFILE,
        registrations: [registration(github)],
        receipts: new MemoryReceipts(),
      }).publish(createPublishRequest()),
    ).resolves.toMatchObject({
      receipts: [],
      failures: [{ channel: 'github', code: 'ADAPTER_UNAVAILABLE' }],
    });
  });

  it('TC-AUTO-DISPATCH-127-02 all-or-none 在任一预检失败时保持零写入', async () => {
    const github = fakeAdapter('github', 'release');
    const dev = fakeAdapter('dev', 'article');
    vi.mocked(dev.preflight).mockRejectedValueOnce(
      new AdapterError('INVALID_CONTENT', 'DEV preflight failed', { retryable: false }),
    );
    const service = new PublishService({
      profile: PROJECT_PROFILE,
      registrations: [registration(github), registration(dev)],
      receipts: new MemoryReceipts(),
    });

    await expect(service.publish(requestWithGitHubAndDev('all-or-none'))).rejects.toMatchObject({
      code: 'PREFLIGHT_FAILED',
    });
    expect(github.publish).not.toHaveBeenCalled();
    expect(dev.publish).not.toHaveBeenCalled();

    vi.mocked(dev.preflight).mockRejectedValueOnce(
      new AdapterError('INVALID_CONTENT', 'DEV preflight failed', { retryable: false }),
    );
    await expect(
      service.publish(requestWithGitHubAndDev('continue-supported')),
    ).resolves.toMatchObject({
      receipts: [{ channel: 'github' }],
      failures: [{ channel: 'dev', code: 'INVALID_CONTENT' }],
    });

    const failingGitHub = fakeAdapter('github', 'release');
    const untouchedDev = fakeAdapter('dev', 'article');
    vi.mocked(failingGitHub.publish).mockRejectedValueOnce(
      new AdapterError('TEMPORARY_FAILURE', 'GitHub failed', { retryable: true }),
    );
    const publishFailureService = new PublishService({
      profile: PROJECT_PROFILE,
      registrations: [registration(failingGitHub), registration(untouchedDev)],
      receipts: new MemoryReceipts(),
    });
    await expect(
      publishFailureService.publish(requestWithGitHubAndDev('all-or-none')),
    ).resolves.toMatchObject({ failures: [{ channel: 'github', code: 'TEMPORARY_FAILURE' }] });
    expect(untouchedDev.publish).not.toHaveBeenCalled();

    vi.mocked(failingGitHub.publish).mockRejectedValueOnce(
      new AdapterError('UNKNOWN_RESULT', 'GitHub result needs lookup', {
        retryable: false,
        stage: 'after-submit',
        lookupRequired: true,
      }),
    );
    await expect(
      publishFailureService.publish(requestWithGitHubAndDev('continue-supported')),
    ).resolves.toMatchObject({
      failures: [
        {
          channel: 'github',
          code: 'UNKNOWN_RESULT',
          stage: 'after-submit',
          lookupRequired: true,
        },
      ],
    });
  });

  it('TC-AUTO-DISPATCH-127-03 既有 receipt 在 adapter 前短路且成功后才保存', async () => {
    const events: string[] = [];
    const github = fakeAdapter('github', 'release');
    vi.mocked(github.publish).mockImplementation(async (input) => {
      events.push('publish');
      return {
        receipt: receipt('github', input.idempotencyKey, input.contentHash),
        reused: false,
      };
    });
    const receipts = new MemoryReceipts();
    const originalSave = receipts.save.bind(receipts);
    receipts.save = async (value) => {
      events.push('save');
      return originalSave(value);
    };
    const service = new PublishService({
      profile: PROJECT_PROFILE,
      registrations: [registration(github)],
      receipts,
    });

    await service.publish(createPublishRequest());
    expect(events).toEqual(['publish', 'save']);

    vi.mocked(github.publish).mockClear();
    events.length = 0;
    await expect(service.publish(createPublishRequest())).resolves.toMatchObject({
      receipts: [{ channel: 'github' }],
    });
    expect(github.publish).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    const changed = createPublishRequest();
    const [changedPackage] = changed.packages;
    const [changedVariant] = changedPackage?.variants ?? [];
    if (!changedVariant) throw new Error('Test fixture is missing its first variant');
    changedVariant.body = 'Different content with the same idempotency key.';
    await expect(service.publish(changed)).resolves.toMatchObject({
      receipts: [],
      failures: [{ channel: 'github', code: 'IDEMPOTENCY_CONFLICT' }],
    });
    expect(github.publish).not.toHaveBeenCalled();

    const invalidReceiptAdapter = fakeAdapter('github', 'release');
    vi.mocked(invalidReceiptAdapter.publish).mockImplementationOnce(async (input) => ({
      receipt: receipt('github', `${input.idempotencyKey}/wrong`, input.contentHash),
      reused: false,
    }));
    const invalidReceiptService = new PublishService({
      profile: PROJECT_PROFILE,
      registrations: [registration(invalidReceiptAdapter)],
      receipts: new MemoryReceipts(),
    });
    await expect(invalidReceiptService.publish(createPublishRequest())).resolves.toMatchObject({
      receipts: [],
      failures: [{ channel: 'github', code: 'UNKNOWN_RESULT' }],
    });

    const racedReceipts = new MemoryReceipts();
    racedReceipts.save = async (value) => ({
      receipt: { ...value, contentHash: 'b'.repeat(64) },
      reused: true,
    });
    await expect(
      new PublishService({
        profile: PROJECT_PROFILE,
        registrations: [registration(fakeAdapter('github', 'release'))],
        receipts: racedReceipts,
      }).publish(createPublishRequest()),
    ).resolves.toMatchObject({
      receipts: [],
      failures: [{ channel: 'github', code: 'UNKNOWN_RESULT' }],
    });
  });

  it('TC-AUTO-ISOLATION-133-01 命中错项目 receipt 时拒绝复用且不调用 adapter', async () => {
    const github = fakeAdapter('github', 'release');
    const receipts = new MemoryReceipts();
    const request = createPublishRequest();
    const expectedKey = `campaign-v3/${request.projectId}/${request.campaignId}/github/${createHash(
      'sha256',
    )
      .update(request.idempotencyKey)
      .digest('hex')
      .slice(0, 32)}`;
    const packageContentHash = createHash('sha256')
      .update(JSON.stringify(request.packages[0]))
      .digest('hex');
    receipts.values.set(expectedKey, {
      ...receipt('github', expectedKey, packageContentHash),
      projectId: 'different-project',
    });

    await expect(
      new PublishService({
        profile: PROJECT_PROFILE,
        registrations: [registration(github)],
        receipts,
      }).publish(request),
    ).resolves.toMatchObject({
      receipts: [],
      failures: [{ channel: 'github', code: 'UNKNOWN_RESULT' }],
    });
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.publish).not.toHaveBeenCalled();
  });
});
