import { describe, expect, it, vi } from 'vitest';
import type { GitHubIssueComment, GitHubIssueRecord } from './adapters/github-cli.js';
import type { CampaignPolicy } from './campaign-policy-store.js';
import { MarketingOpsError } from './errors.js';
import type { ProjectProfile } from './project-profile-store.js';
import { createLocalRuntimeToolHandler } from './local-runtime.js';
import type { ProjectPublishReceipt, PublicPostRef, PublishReceipt } from './receipt-store.js';
import { receiptProjectId } from './receipt-store.js';

const PROJECT: ProjectProfile = {
  schemaVersion: 1,
  id: 'algorithm-visualizer',
  displayName: 'Algorithm Visualizer',
  canonicalOrigins: ['https://algo.illegalscreed.cn'],
  channels: ['github', 'dev'],
  github: { repository: 'IllegalCreed/algorithms-visualization' },
  dev: { tags: ['algorithms', 'webdev', 'opensource'] },
};

function receipt(
  channel: ProjectPublishReceipt['channel'],
  adapterVersion: string,
  postId: string,
  publicUrl: string,
): ProjectPublishReceipt {
  return {
    schemaVersion: 2,
    projectId: PROJECT.id,
    campaignId: 'quick-sort-launch',
    channel,
    postId,
    publicUrl,
    publishedAt: '2026-07-28T00:00:00.000Z',
    contentHash: 'a'.repeat(64),
    idempotencyKey: `campaign-v3/${PROJECT.id}/quick-sort-launch/${channel}/${postId}`,
    adapterVersion,
    status: 'published',
  };
}

class MemoryReceipts {
  values: PublishReceipt[];

  constructor(values: PublishReceipt[]) {
    this.values = values;
  }

  async getByIdempotencyKey(key: string) {
    return this.values.find((value) => value.idempotencyKey === key) ?? null;
  }

  async save(value: PublishReceipt) {
    const existing = await this.getByIdempotencyKey(value.idempotencyKey);
    if (existing) return { receipt: existing, reused: true };
    this.values.push(value);
    return { receipt: value, reused: false };
  }

  async listByCampaign(projectId: string, campaignId: string) {
    return this.values.filter(
      (value) => receiptProjectId(value) === projectId && value.campaignId === campaignId,
    );
  }

  async findKnownPostRef(projectId: string, postRef: PublicPostRef) {
    return (
      this.values.find(
        (value) =>
          receiptProjectId(value) === projectId &&
          value.channel === postRef.channel &&
          value.postId === postRef.postId &&
          value.publicUrl === postRef.publicUrl,
      ) ?? null
    );
  }

  async findByPostRef(projectId: string, campaignId: string, postRef: PublicPostRef) {
    return (
      this.values.find(
        (value) =>
          receiptProjectId(value) === projectId &&
          value.campaignId === campaignId &&
          value.channel === postRef.channel &&
          value.postId === postRef.postId &&
          value.publicUrl === postRef.publicUrl,
      ) ?? null
    );
  }

  async markDeleted(): Promise<PublishReceipt> {
    throw new Error('not used');
  }
}

class MemoryPolicies {
  value: CampaignPolicy | null = {
    schemaVersion: 1,
    projectId: PROJECT.id,
    campaignId: 'quick-sort-launch',
    replies: { mode: 'faq-only', createBugIssues: true },
  };

  async save(value: CampaignPolicy) {
    this.value = value;
    return { policy: value, reused: false };
  }

  async get(projectId: string, campaignId: string) {
    return this.value?.projectId === projectId && this.value.campaignId === campaignId
      ? this.value
      : null;
  }
}

function issueRecord(body: string): GitHubIssueRecord {
  return {
    number: 12,
    htmlUrl: 'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
    title: 'Feedback triage: possible bug in quick-sort-launch',
    body,
    state: 'open',
    createdAt: '2026-07-28T01:00:00Z',
    updatedAt: '2026-07-28T01:00:00Z',
  };
}

function issueComment(body: string, id = 22): GitHubIssueComment {
  return {
    id,
    htmlUrl: `https://github.com/IllegalCreed/algorithms-visualization/issues/12#issuecomment-${id}`,
    body,
    userLogin: 'reader',
    createdAt: '2026-07-28T01:00:00Z',
    updatedAt: '2026-07-28T01:00:00Z',
  };
}

function github() {
  const comments: GitHubIssueComment[] = [];
  const issueClient = {
    listIssues: vi.fn(async () => [] as GitHubIssueRecord[]),
    createIssue: vi.fn(async (_repository: string, draft: { title: string; body: string }) =>
      issueRecord(draft.body),
    ),
    listIssueComments: vi.fn(async () => comments),
    createIssueComment: vi.fn(async (_repository: string, _issueNumber: number, body: string) => {
      const created = issueComment(body);
      comments.push(created);
      return created;
    }),
  };
  return {
    comments,
    issueClient,
    getStatus: vi.fn(async () => ({
      channel: 'github' as const,
      alias: 'IllegalCreed',
      health: 'ready' as const,
      adapterReady: true,
      nextAction: null,
    })),
    createRegistration: vi.fn(async () => null),
    createEnabledClient: vi.fn(async () => ({
      getRelease: vi.fn(async () => ({
        id: 7,
        tagName: 'marketing/algorithm-visualizer/quick-sort-launch',
        name: 'Quick Sort',
        body: 'body',
        htmlUrl:
          'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Falgorithm-visualizer%2Fquick-sort-launch',
        publishedAt: '2026-07-28T00:00:00Z',
        assets: [],
      })),
      listReleaseReactions: vi.fn(async () => []),
      getTrafficViews: vi.fn(async () => ({ count: 0, uniques: 0, points: [] })),
      getTrafficClones: vi.fn(async () => ({ count: 0, uniques: 0, points: [] })),
      getTrafficReferrers: vi.fn(async () => []),
      getTrafficPaths: vi.fn(async () => []),
      listIssueComments: issueClient.listIssueComments,
    })),
    createEnabledIssueClient: vi.fn(async () => issueClient),
  };
}

describe('T4 local runtime orchestration', () => {
  it('TC-AUTO-SCHEDULE-127-03..04 status 可恢复计划且到期前不采集', async () => {
    const release = receipt(
      'github',
      'github-release@1.3.0',
      '7',
      'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Falgorithm-visualizer%2Fquick-sort-launch',
    );
    const artifact = receipt(
      'github',
      'github-issue@1.1.0',
      '12',
      'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
    );
    const receipts = new MemoryReceipts([release, artifact]);
    const gh = github();
    let now = '2026-07-28T00:30:00.000Z';
    const handler = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => gh,
      receipts,
      campaignPolicies: new MemoryPolicies(),
      now: () => now,
    });

    const status = await handler('get_publish_status', {
      projectId: PROJECT.id,
      campaignId: 'quick-sort-launch',
    });
    expect(status).toMatchObject({ data: { followUps: expect.any(Array) } });
    expect((status.data as { followUps: unknown[] }).followUps).toHaveLength(3);
    expect((status.data as { followUps: unknown[] }).followUps[0]).toMatchObject({
      window: '1h',
      dueAt: '2026-07-28T01:00:00.000Z',
    });
    await expect(
      handler('get_campaign_report', {
        projectId: PROJECT.id,
        campaignId: 'quick-sort-launch',
        window: '1h',
      }),
    ).resolves.toMatchObject({
      data: {
        status: 'scheduled',
        artifacts: [{ adapterVersion: 'github-issue@1.1.0' }],
      },
    });
    expect(gh.createEnabledClient).not.toHaveBeenCalled();

    now = '2026-07-28T01:00:00.000Z';
    await expect(
      handler('get_campaign_report', {
        projectId: PROJECT.id,
        campaignId: 'quick-sort-launch',
        window: '1h',
      }),
    ).resolves.toMatchObject({
      data: { schemaVersion: 1, status: 'available', channels: [{ channel: 'github' }] },
    });
  });

  it('TC-AUTO-BUGROUTE-127-03..05 已知 Bug feedback 创建幂等 GitHub Issue artifact', async () => {
    const article = receipt(
      'dev',
      'dev-article@0.2.0',
      '4146005',
      'https://dev.to/illegal/quick-sort',
    );
    const receipts = new MemoryReceipts([article]);
    const gh = github();
    const handler = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => gh,
      dev: {
        getStatus: vi.fn(),
        createRegistration: vi.fn(),
        createEnabledClient: vi.fn(async () => ({
          getArticle: vi.fn(async () => ({
            id: 4146005,
            title: 'Quick Sort',
            description: 'desc',
            bodyMarkdown: 'body',
            canonicalUrl: 'https://algo.illegalscreed.cn/en/docs/quick-sort/',
            publicUrl: article.publicUrl,
            publishedAt: article.publishedAt,
            commentsCount: 1,
            publicReactionsCount: 0,
            positiveReactionsCount: 0,
          })),
          listComments: vi.fn(async () => [
            {
              id: '42',
              bodyHtml: 'The reset button stays sorted after I enter 3,2,1; it happens every time.',
              createdAt: '2026-07-28T00:30:00Z',
              authorAlias: 'reader',
              children: [],
            },
          ]),
        })),
      },
      receipts,
      campaignPolicies: new MemoryPolicies(),
      now: () => '2026-07-28T01:00:00.000Z',
    });

    const request = {
      projectId: PROJECT.id,
      campaignId: 'quick-sort-launch',
      postRef: { channel: 'dev' as const, postId: article.postId, publicUrl: article.publicUrl },
      commentId: 'dev-comment:42',
      action: 'bug-issue' as const,
      policy: 'faq-only' as const,
      idempotencyKey: 'feedback/quick-sort-launch/dev-comment-42',
      authorization: {
        source: 'owner-prompt' as const,
        authorizedAt: '2026-07-28T01:00:00.000Z',
      },
    };
    await expect(handler('reply_feedback', request)).resolves.toMatchObject({
      data: {
        action: 'bug-issue',
        receipt: { adapterVersion: 'github-issue@1.1.0', status: 'published' },
      },
    });
    await expect(handler('reply_feedback', request)).resolves.toMatchObject({
      data: { action: 'bug-issue', reused: true },
    });
    expect(gh.issueClient.createIssue).toHaveBeenCalledOnce();
    expect(gh.issueClient.createIssue.mock.calls[0]?.[1].body).not.toContain(
      'The reset button stays sorted',
    );
  });

  it('TC-AUTO-FAQ-127-04 / TC-AUTO-GHREPLY-127-01..05 只用固定模板幂等回复已知 FAQ', async () => {
    const issue = receipt(
      'github',
      'github-issue@1.1.0',
      '12',
      'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
    );
    const receipts = new MemoryReceipts([issue]);
    const gh = github();
    gh.comments.push(issueComment('Where can I find the documentation?', 21));
    const handler = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => gh,
      receipts,
      campaignPolicies: new MemoryPolicies(),
    });
    const request = {
      projectId: PROJECT.id,
      campaignId: 'quick-sort-launch',
      postRef: {
        channel: 'github' as const,
        postId: issue.postId,
        publicUrl: issue.publicUrl,
      },
      commentId: 'issue-comment:21',
      action: 'faq-reply' as const,
      policy: 'faq-only' as const,
      idempotencyKey: 'feedback/quick-sort-launch/issue-comment-21',
      authorization: {
        source: 'owner-prompt' as const,
        authorizedAt: '2026-07-28T01:00:00.000Z',
      },
    };

    await expect(handler('reply_feedback', request)).resolves.toMatchObject({
      data: {
        action: 'faq-reply',
        body: 'Project documentation: https://algo.illegalscreed.cn/',
        receipt: { adapterVersion: 'github-issue-reply@1.0.0', status: 'published' },
        reused: false,
      },
    });
    await expect(handler('reply_feedback', request)).resolves.toMatchObject({
      data: { action: 'faq-reply', reused: true },
    });
    expect(gh.issueClient.createIssueComment).toHaveBeenCalledOnce();
    expect(gh.issueClient.createIssueComment.mock.calls[0]?.[2]).not.toContain('Where can I find');
  });

  it('TC-AUTO-REPORT-127-04 collector 错误逐渠道标准化且无发布时报告不可用', async () => {
    const release = receipt(
      'github',
      'github-release@1.3.0',
      '7',
      'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Falgorithm-visualizer%2Fquick-sort-launch',
    );
    const cases = [
      [new MarketingOpsError('INVALID_INPUT', 'safe'), 'INVALID_INPUT'],
      [new MarketingOpsError('STORAGE_CORRUPTED', 'safe'), 'STORAGE_CORRUPTED'],
      [new MarketingOpsError('REAUTH_REQUIRED', 'safe'), 'REAUTH_REQUIRED'],
      [new MarketingOpsError('ADAPTER_UNAVAILABLE', 'safe'), 'ADAPTER_UNAVAILABLE'],
      [new Error('private failure'), 'ADAPTER_UNAVAILABLE'],
    ] as const;

    for (const [error, code] of cases) {
      const gh = github();
      gh.createEnabledClient.mockRejectedValue(error);
      const handler = createLocalRuntimeToolHandler({
        projects: { require: vi.fn(async () => PROJECT) },
        github: () => gh,
        receipts: new MemoryReceipts([release]),
        now: () => '2026-07-28T01:00:00.000Z',
      });
      await expect(
        handler('get_campaign_report', {
          projectId: PROJECT.id,
          campaignId: 'quick-sort-launch',
          window: '1h',
        }),
      ).resolves.toMatchObject({
        data: { channels: [{ status: 'failed', code, retryable: false }] },
      });
    }

    const empty = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github,
      receipts: new MemoryReceipts([]),
    });
    await expect(
      empty('get_campaign_report', {
        projectId: PROJECT.id,
        campaignId: 'quick-sort-launch',
        window: '1h',
      }),
    ).resolves.toMatchObject({
      data: {
        status: 'unavailable',
        reason: 'No successful primary publication receipt was found',
      },
    });
  });

  it('TC-AUTO-FAQ-127-02..04 模糊、异模板、禁用 Issue client 与未支持渠道全部失败关闭', async () => {
    const issue = receipt(
      'github',
      'github-issue@1.1.0',
      '12',
      'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
    );
    const request = {
      projectId: PROJECT.id,
      campaignId: 'quick-sort-launch',
      postRef: {
        channel: 'github' as const,
        postId: issue.postId,
        publicUrl: issue.publicUrl,
      },
      commentId: 'issue-comment:21',
      action: 'faq-reply' as const,
      policy: 'faq-only' as const,
      idempotencyKey: 'feedback/quick-sort-launch/failure-0001',
      authorization: {
        source: 'owner-prompt' as const,
        authorizedAt: '2026-07-28T01:00:00.000Z',
      },
    };

    const unclearGitHub = github();
    unclearGitHub.comments.push(issueComment('This is bad.', 21));
    const unclear = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => unclearGitHub,
      receipts: new MemoryReceipts([issue]),
      campaignPolicies: new MemoryPolicies(),
    });
    await expect(unclear('reply_feedback', request)).resolves.toMatchObject({
      isError: true,
      data: { code: 'ADAPTER_UNAVAILABLE' },
    });

    const faqGitHub = github();
    faqGitHub.comments.push(issueComment('Where can I find the documentation?', 21));
    const unavailableIssueClient = {
      ...faqGitHub,
      createEnabledIssueClient: vi.fn(async () => null),
    };
    const faq = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => unavailableIssueClient,
      receipts: new MemoryReceipts([issue]),
      campaignPolicies: new MemoryPolicies(),
    });
    await expect(
      faq('reply_feedback', { ...request, body: 'Caller-authored reply.' }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'INVALID_INPUT' } });
    await expect(faq('reply_feedback', request)).resolves.toMatchObject({
      isError: true,
      data: { code: 'ADAPTER_UNAVAILABLE' },
    });

    const deleted = new MemoryReceipts([{ ...issue, status: 'deleted' }]);
    const deletedHandler = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => faqGitHub,
      receipts: deleted,
      campaignPolicies: new MemoryPolicies(),
    });
    await expect(deletedHandler('reply_feedback', request)).resolves.toMatchObject({
      isError: true,
      data: { code: 'INVALID_INPUT' },
    });

    const bluesky = receipt(
      'bluesky',
      'bluesky-text@0.2.0',
      'at://did:plc:example/app.bsky.feed.post/1',
      'https://bsky.app/profile/example/post/1',
    );
    const unsupported = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => faqGitHub,
      receipts: new MemoryReceipts([bluesky]),
      campaignPolicies: new MemoryPolicies(),
    });
    await expect(
      unsupported('reply_feedback', {
        ...request,
        postRef: {
          channel: 'bluesky',
          postId: bluesky.postId,
          publicUrl: bluesky.publicUrl,
        },
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
  });

  it('TC-AUTO-BUGROUTE-127-03 policy、分类、仓库配置与本地 receipt 冲突失败关闭', async () => {
    const issue = receipt(
      'github',
      'github-issue@1.1.0',
      '12',
      'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
    );
    const bugRequest = {
      projectId: PROJECT.id,
      campaignId: 'quick-sort-launch',
      postRef: {
        channel: 'github' as const,
        postId: issue.postId,
        publicUrl: issue.publicUrl,
      },
      commentId: 'issue-comment:21',
      action: 'bug-issue' as const,
      policy: 'faq-only' as const,
      idempotencyKey: 'feedback/quick-sort-launch/bug-failure-0001',
      authorization: {
        source: 'owner-prompt' as const,
        authorizedAt: '2026-07-28T01:00:00.000Z',
      },
    };
    const gh = github();
    gh.comments.push(
      issueComment('The reset button stays sorted after I enter 3,2,1; it happens every time.', 21),
    );
    const disabledPolicy = new MemoryPolicies();
    disabledPolicy.value = {
      ...disabledPolicy.value!,
      replies: { mode: 'faq-only', createBugIssues: false },
    };
    const disabled = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => gh,
      receipts: new MemoryReceipts([issue]),
      campaignPolicies: disabledPolicy,
    });
    await expect(disabled('reply_feedback', bugRequest)).resolves.toMatchObject({
      isError: true,
      data: { code: 'ADAPTER_UNAVAILABLE' },
    });

    gh.comments[0] = issueComment('This is bad.', 21);
    const wrongClass = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => gh,
      receipts: new MemoryReceipts([issue]),
      campaignPolicies: new MemoryPolicies(),
    });
    await expect(wrongClass('reply_feedback', bugRequest)).resolves.toMatchObject({
      isError: true,
      data: { code: 'ADAPTER_UNAVAILABLE' },
    });

    gh.comments[0] = issueComment(
      'The reset button stays sorted after I enter 3,2,1; it happens every time.',
      21,
    );
    const receipts = new MemoryReceipts([issue]);
    const success = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => gh,
      receipts,
      campaignPolicies: new MemoryPolicies(),
    });
    const created = await success('reply_feedback', bugRequest);
    const artifact = (created.data as { receipt: PublishReceipt }).receipt;
    artifact.adapterVersion = 'github-issue-reply@1.0.0';
    await expect(success('reply_feedback', bugRequest)).resolves.toMatchObject({
      isError: true,
      data: { code: 'STORAGE_CORRUPTED' },
    });

    const article = receipt(
      'dev',
      'dev-article@0.2.0',
      '4146005',
      'https://dev.to/illegal/quick-sort',
    );
    const { github: _github, ...projectWithoutGitHub } = PROJECT;
    const noGitHub: ProjectProfile = { ...projectWithoutGitHub, channels: ['dev'] };
    const missingRepository = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => noGitHub) },
      github: () => github(),
      dev: {
        getStatus: vi.fn(),
        createRegistration: vi.fn(),
        createEnabledClient: vi.fn(async () => ({
          getArticle: vi.fn(async () => ({
            id: 4146005,
            title: 'Quick Sort',
            description: 'desc',
            bodyMarkdown: 'body',
            canonicalUrl: 'https://algo.illegalscreed.cn/en/docs/quick-sort/',
            publicUrl: article.publicUrl,
            publishedAt: article.publishedAt,
            commentsCount: 1,
            publicReactionsCount: 0,
            positiveReactionsCount: 0,
          })),
          listComments: vi.fn(async () => [
            {
              id: '42',
              bodyHtml: 'The reset button stays sorted after I enter 3,2,1; it happens every time.',
              createdAt: '2026-07-28T00:30:00Z',
              authorAlias: 'reader',
              children: [],
            },
          ]),
        })),
      },
      receipts: new MemoryReceipts([article]),
      campaignPolicies: new MemoryPolicies(),
    });
    await expect(
      missingRepository('reply_feedback', {
        ...bugRequest,
        postRef: { channel: 'dev', postId: article.postId, publicUrl: article.publicUrl },
        commentId: 'dev-comment:42',
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'INVALID_INPUT' } });
  });

  it('TC-AUTO-FAQ-127-03 feedback 精确回读支持 Mastodon，并有界分页后拒绝未知 ID', async () => {
    const mastodonReceipt = receipt(
      'mastodon',
      'mastodon-status@0.1.0',
      '201',
      'https://mastodon.social/@illegalcreed/201',
    );
    const mastodonProject: ProjectProfile = {
      ...PROJECT,
      channels: ['github', 'mastodon'],
    };
    const mastodonHandler = createLocalRuntimeToolHandler({
      projects: {
        require: vi.fn(async () => mastodonProject),
      },
      github,
      mastodon: {
        getStatus: vi.fn(),
        createRegistration: vi.fn(),
        createEnabledClient: vi.fn(async () => ({
          getStatus: vi.fn(),
          listNotifications: vi.fn(async () => [
            {
              id: 'n1',
              type: 'mention' as const,
              createdAt: '2026-07-28T00:30:00Z',
              authorAlias: 'reader@example.social',
              statusId: '201',
              statusUrl: mastodonReceipt.publicUrl,
              bodyHtml: '<p>Thanks!</p>',
            },
          ]),
        })),
      },
      receipts: new MemoryReceipts([mastodonReceipt]),
      campaignPolicies: new MemoryPolicies(),
    });
    await expect(
      mastodonHandler('reply_feedback', {
        projectId: PROJECT.id,
        campaignId: 'quick-sort-launch',
        postRef: {
          channel: 'mastodon',
          postId: mastodonReceipt.postId,
          publicUrl: mastodonReceipt.publicUrl,
        },
        commentId: 'mastodon-notification:n1',
        action: 'faq-reply',
        policy: 'faq-only',
        idempotencyKey: 'feedback/quick-sort-launch/masto-0001',
        authorization: {
          source: 'owner-prompt',
          authorizedAt: '2026-07-28T01:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });

    const issue = receipt(
      'github',
      'github-issue@1.1.0',
      '12',
      'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
    );
    const pagedGitHub = github();
    pagedGitHub.comments.push(
      ...Array.from({ length: 100 }, (_, index) => issueComment(`Comment ${index}`, index + 1)),
    );
    const paged = createLocalRuntimeToolHandler({
      projects: { require: vi.fn(async () => PROJECT) },
      github: () => pagedGitHub,
      receipts: new MemoryReceipts([issue]),
      campaignPolicies: new MemoryPolicies(),
    });
    await expect(
      paged('reply_feedback', {
        projectId: PROJECT.id,
        campaignId: 'quick-sort-launch',
        postRef: { channel: 'github', postId: issue.postId, publicUrl: issue.publicUrl },
        commentId: 'issue-comment:999',
        action: 'faq-reply',
        policy: 'faq-only',
        idempotencyKey: 'feedback/quick-sort-launch/missing-0001',
        authorization: {
          source: 'owner-prompt',
          authorizedAt: '2026-07-28T01:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'INVALID_INPUT' } });
  });
});
