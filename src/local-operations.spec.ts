import { describe, expect, it, vi } from 'vitest';
import { AdapterError, type ChannelAdapter } from './adapters/contract.js';
import type { GitHubObservabilityClient } from './github-observability.js';
import { createLocalRuntimeToolHandler } from './local-runtime.js';
import type { AdapterRegistration } from './publish-service.js';
import type { PublishReceipt } from './receipt-store.js';
import { receiptProjectId } from './receipt-store.js';
import type { ProjectProfile } from './project-profile-store.js';

const RELEASE_URL =
  'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Falgorithm-visualizer%2Fquick-sort-launch';
const PROJECT_ID = 'algorithm-visualizer';
const PROJECT_PROFILE: ProjectProfile = {
  schemaVersion: 1,
  id: PROJECT_ID,
  displayName: 'Algorithm Visualizer',
  canonicalOrigins: ['https://algo.illegalscreed.cn'],
  channels: ['github', 'weibo'],
  github: { repository: 'IllegalCreed/algorithms-visualization' },
};

function receipt(status: PublishReceipt['status'] = 'published'): PublishReceipt {
  return {
    schemaVersion: 2,
    projectId: PROJECT_ID,
    campaignId: 'quick-sort-launch',
    channel: 'github',
    postId: '7',
    publicUrl: RELEASE_URL,
    publishedAt: '2026-07-11T00:00:00.000Z',
    contentHash: 'a'.repeat(64),
    idempotencyKey: 'campaign-v2/quick-sort-launch/github/abc12345',
    adapterVersion: 'github-release@1.0.0',
    status,
  };
}

class MemoryOperationsReceipts {
  value = receipt();

  async getByIdempotencyKey(key: string) {
    return key === this.value.idempotencyKey ? this.value : null;
  }

  async save(value: PublishReceipt) {
    this.value = value;
    return { receipt: value, reused: false };
  }

  async listByCampaign(projectId: string, campaignId: string) {
    return projectId === receiptProjectId(this.value) && campaignId === this.value.campaignId
      ? [this.value]
      : [];
  }

  async findByPostRef(
    projectId: string,
    campaignId: string,
    postRef: { channel: string; postId: string; publicUrl: string },
  ) {
    return projectId === receiptProjectId(this.value) &&
      campaignId === this.value.campaignId &&
      postRef.channel === this.value.channel &&
      postRef.postId === this.value.postId &&
      postRef.publicUrl === this.value.publicUrl
      ? this.value
      : null;
  }

  async findKnownPostRef(
    projectId: string,
    postRef: { channel: string; postId: string; publicUrl: string },
  ) {
    return projectId === receiptProjectId(this.value) &&
      postRef.channel === this.value.channel &&
      postRef.postId === this.value.postId &&
      postRef.publicUrl === this.value.publicUrl
      ? this.value
      : null;
  }

  async markDeleted(projectId: string, key: string) {
    if (projectId !== receiptProjectId(this.value) || key !== this.value.idempotencyKey) {
      throw new Error('not found');
    }
    this.value = { ...this.value, status: 'deleted' };
    return this.value;
  }
}

function observabilityClient(): GitHubObservabilityClient {
  return {
    getRelease: vi.fn(async () => ({
      id: 7,
      tagName: 'marketing/quick-sort-launch',
      name: 'Quick Sort',
      body: '<!-- marker -->',
      htmlUrl: RELEASE_URL,
      publishedAt: '2026-07-11T00:00:00Z',
      assets: [],
    })),
    listReleaseReactions: vi.fn(async () => [
      {
        id: 11,
        content: 'rocket' as const,
        userLogin: 'reader',
        createdAt: '2026-07-11T01:00:00Z',
      },
    ]),
    getTrafficViews: vi.fn(async () => ({ count: 0, uniques: 0, points: [] })),
    getTrafficClones: vi.fn(async () => ({ count: 0, uniques: 0, points: [] })),
    getTrafficReferrers: vi.fn(async () => []),
    getTrafficPaths: vi.fn(async () => []),
    listIssueComments: vi.fn(async () => [
      {
        id: 21,
        htmlUrl:
          'https://github.com/IllegalCreed/algorithms-visualization/issues/12#issuecomment-21',
        body: 'Issue feedback',
        userLogin: 'reader',
        createdAt: '2026-07-11T01:00:00Z',
        updatedAt: '2026-07-11T01:00:00Z',
      },
    ]),
  };
}

function registration() {
  const adapter: ChannelAdapter = {
    definition: {
      channel: 'github',
      version: 'github-release@1.0.0',
      capabilities: {
        publish: true,
        status: true,
        metrics: true,
        feedback: true,
        reply: false,
        delete: true,
      },
    },
    expectedFormat: 'release',
    preflight: vi.fn(async () => undefined),
    publish: vi.fn(async () => {
      throw new Error('not used');
    }),
    delete: vi.fn(async () => ({ status: 'deleted' as const })),
  };
  return { adapter, enabled: true, health: 'ready' as const };
}

function github(enabled = true) {
  const value = registration();
  return {
    registration: value,
    getStatus: vi.fn(async () => ({
      channel: 'github' as const,
      alias: 'IllegalCreed',
      health: 'ready' as const,
      adapterReady: enabled,
      nextAction: enabled ? null : 'Run marketing-ops setup github',
    })),
    createRegistration: vi.fn(async (): Promise<AdapterRegistration | null> =>
      enabled ? value : null,
    ),
    createEnabledClient: vi.fn(async () => (enabled ? observabilityClient() : null)),
  };
}

function runtime(
  controller = github(),
  receipts: MemoryOperationsReceipts = new MemoryOperationsReceipts(),
) {
  return createLocalRuntimeToolHandler({
    projects: { require: vi.fn(async () => PROJECT_PROFILE) },
    github: () => controller,
    receipts,
  });
}

describe('local GitHub status, feedback, report and delete operations', () => {
  it('TC-AUTO-GHOPS-127-01 get_publish_status 返回本地真实 receipt', async () => {
    const handler = runtime();

    await expect(
      handler('get_publish_status', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
      }),
    ).resolves.toMatchObject({
      data: {
        campaignId: 'quick-sort-launch',
        status: 'complete',
        receipts: [{ postId: '7', status: 'published' }],
        failures: [],
      },
    });
  });

  it('TC-AUTO-GHOPS-127-02..03 feedback/report 使用 enabled client 且带观测限制', async () => {
    const receipts = new MemoryOperationsReceipts();
    const controller = github();
    const handler = runtime(controller, receipts);

    await expect(
      handler('list_feedback', {
        projectId: PROJECT_ID,
        postRef: { channel: 'github', postId: '7', publicUrl: RELEASE_URL },
      }),
    ).resolves.toMatchObject({
      data: { items: [{ kind: 'reaction', untrusted: true }], nextCursor: null },
    });
    await expect(
      handler('get_campaign_report', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
        window: '48h',
      }),
    ).resolves.toMatchObject({
      data: {
        campaignId: 'quick-sort-launch',
        window: '48h',
        status: 'available',
        channels: [expect.objectContaining({ attribution: 'not-attributable-to-campaign' })],
      },
    });

    receipts.value = {
      ...receipts.value,
      postId: '12',
      publicUrl: 'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
      adapterVersion: 'github-issue@1.0.0',
    };
    await expect(
      handler('list_feedback', {
        projectId: PROJECT_ID,
        postRef: {
          channel: 'github',
          postId: '12',
          publicUrl: receipts.value.publicUrl,
        },
      }),
    ).resolves.toMatchObject({
      data: { items: [{ kind: 'comment', body: 'Issue feedback', untrusted: true }] },
    });
    expect(controller.createEnabledClient).toHaveBeenCalledTimes(3);
  });

  it('TC-AUTO-GHOPS-127-04..05 delete 只接受已知 receipt，失去启用状态时全部失败关闭', async () => {
    const receipts = new MemoryOperationsReceipts();
    const controller = github();
    const handler = runtime(controller, receipts);
    const authorization = {
      source: 'owner-prompt',
      authorizedAt: '2026-07-11T03:00:00.000Z',
    };

    await expect(
      handler('delete_post', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
        postRef: { channel: 'github', postId: '7', publicUrl: RELEASE_URL },
        idempotencyKey: 'delete/quick-sort-launch/0001',
        authorization,
      }),
    ).resolves.toMatchObject({ data: { status: 'deleted' } });
    expect(receipts.value.status).toBe('deleted');

    const disabled = runtime(github(false));
    await expect(
      disabled('list_feedback', {
        projectId: PROJECT_ID,
        postRef: { channel: 'github', postId: '7', publicUrl: RELEASE_URL },
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
    await expect(
      disabled('delete_post', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
        postRef: { channel: 'github', postId: '7', publicUrl: RELEASE_URL },
        idempotencyKey: 'delete/quick-sort-launch/0002',
        authorization,
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
  });

  it('TC-AUTO-GHOPS-127-01..05 状态、引用、能力与内部异常分支全部失败关闭', async () => {
    const authorization = {
      source: 'owner-prompt' as const,
      authorizedAt: '2026-07-11T03:00:00.000Z',
    };
    const postRef = { channel: 'github' as const, postId: '7', publicUrl: RELEASE_URL };

    const empty = runtime();
    await expect(
      empty('get_publish_status', {
        projectId: PROJECT_ID,
        campaignId: 'missing-campaign',
      }),
    ).resolves.toMatchObject({ data: { status: 'not-found', receipts: [] } });

    const queuedReceipts = new MemoryOperationsReceipts();
    queuedReceipts.value = { ...queuedReceipts.value, status: 'queued' };
    const queued = runtime(github(), queuedReceipts);
    await expect(
      queued('get_publish_status', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
      }),
    ).resolves.toMatchObject({ data: { status: 'in-progress' } });
    await expect(
      queued('list_feedback', {
        projectId: PROJECT_ID,
        postRef: { channel: 'v2ex', postId: '1', publicUrl: 'https://v2ex.com/t/1' },
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
    await expect(
      queued('list_feedback', { projectId: PROJECT_ID, postRef }),
    ).resolves.toMatchObject({
      isError: true,
      data: { code: 'INVALID_INPUT' },
    });

    const missing = runtime();
    await expect(
      missing('list_feedback', {
        projectId: PROJECT_ID,
        postRef: { ...postRef, postId: '8' },
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'INVALID_INPUT' } });

    for (const value of [
      { ...receipt(), channel: 'weibo' as const },
      { ...receipt(), status: 'deleted' as const },
      {
        ...receipt(),
        publicUrl: 'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
      },
    ]) {
      const filteredReceipts = new MemoryOperationsReceipts();
      filteredReceipts.value = value;
      const filtered = runtime(github(), filteredReceipts);
      await expect(
        filtered('get_campaign_report', {
          projectId: PROJECT_ID,
          campaignId: 'quick-sort-launch',
          window: '1h',
        }),
      ).resolves.toMatchObject({ data: { status: 'unavailable' } });
    }

    await expect(
      missing('delete_post', {
        projectId: PROJECT_ID,
        campaignId: 'other-campaign',
        postRef,
        idempotencyKey: 'delete/quick-sort-launch/0003',
        authorization,
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'INVALID_INPUT' } });

    const deletedReceipts = new MemoryOperationsReceipts();
    deletedReceipts.value = receipt('deleted');
    const deleted = runtime(github(), deletedReceipts);
    await expect(
      deleted('delete_post', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
        postRef,
        idempotencyKey: 'delete/quick-sort-launch/0004',
        authorization,
      }),
    ).resolves.toMatchObject({ data: { status: 'already-deleted' } });

    const nonGitHubReceipts = new MemoryOperationsReceipts();
    nonGitHubReceipts.value = {
      ...receipt(),
      channel: 'weibo',
      postId: 'weibo-1',
      publicUrl: 'https://weibo.com/1/weibo-1',
    };
    const nonGitHub = runtime(github(), nonGitHubReceipts);
    await expect(
      nonGitHub('delete_post', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
        postRef: {
          channel: 'weibo',
          postId: 'weibo-1',
          publicUrl: 'https://weibo.com/1/weibo-1',
        },
        idempotencyKey: 'delete/quick-sort-launch/0005',
        authorization,
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });

    const failedReceipts = new MemoryOperationsReceipts();
    failedReceipts.value = receipt('failed');
    const failed = runtime(github(), failedReceipts);
    await expect(
      failed('delete_post', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
        postRef,
        idempotencyKey: 'delete/quick-sort-launch/0006',
        authorization,
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'INVALID_INPUT' } });

    const noDeleteController = github();
    delete noDeleteController.registration.adapter.delete;
    const noDelete = runtime(noDeleteController);
    await expect(
      noDelete('delete_post', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
        postRef,
        idempotencyKey: 'delete/quick-sort-launch/0007',
        authorization,
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });

    await expect(
      noDelete('reply_feedback', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
        postRef,
        commentId: 'comment-1',
        body: 'Thanks for the report.',
        policy: 'faq-only',
        idempotencyKey: 'reply/quick-sort-launch/0001',
        authorization,
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
    await expect(noDelete('unknown' as never, {})).resolves.toMatchObject({
      isError: true,
      data: { code: 'ADAPTER_UNAVAILABLE' },
    });

    const adapterFailureController = github();
    const failedClient = observabilityClient();
    failedClient.getRelease = vi.fn(async () => {
      throw new AdapterError('TEMPORARY_FAILURE', 'safe failure', { retryable: true });
    });
    adapterFailureController.createEnabledClient.mockResolvedValue(failedClient);
    const adapterFailure = runtime(adapterFailureController);
    await expect(
      adapterFailure('get_campaign_report', {
        projectId: PROJECT_ID,
        campaignId: 'quick-sort-launch',
        window: '7d',
      }),
    ).resolves.toMatchObject({
      data: {
        status: 'unavailable',
        channels: [
          {
            channel: 'github',
            status: 'failed',
            code: 'TEMPORARY_FAILURE',
            retryable: true,
          },
        ],
      },
    });

    const brokenReceipts = new MemoryOperationsReceipts();
    brokenReceipts.listByCampaign = vi.fn(async () => {
      throw new Error('Bearer private-token');
    });
    const broken = runtime(github(), brokenReceipts);
    const result = await broken('get_publish_status', {
      projectId: PROJECT_ID,
      campaignId: 'quick-sort-launch',
    });
    expect(result).toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
});
