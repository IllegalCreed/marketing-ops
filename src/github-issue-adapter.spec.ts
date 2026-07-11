import { describe, expect, it, vi } from 'vitest';
import { AdapterTransportError } from './adapters/contract.js';
import {
  buildGitHubIssueDraft,
  GitHubIssueAdapter,
  type GitHubIssueClient,
  type GitHubIssueInput,
} from './adapters/github-issue.js';

const REPOSITORY = 'IllegalCreed/algorithms-visualization';

function input(overrides: Partial<GitHubIssueInput> = {}): GitHubIssueInput {
  return {
    campaignId: 'quick-sort-launch',
    idempotencyKey: 'issue/quick-sort-launch/feedback-0001',
    title: 'Reset behavior feedback',
    body: 'The reset button does not restore the expected input.',
    sourceUrls: ['https://github.com/IllegalCreed/algorithms-visualization/issues/1'],
    ...overrides,
  };
}

function record(body: string) {
  return {
    number: 12,
    htmlUrl: 'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
    title: 'Reset behavior feedback',
    body,
    state: 'open' as const,
    createdAt: '2026-07-11T00:00:00Z',
    updatedAt: '2026-07-11T00:00:00Z',
  };
}

function client(pages: Array<ReturnType<typeof record>[]> = [[]]): GitHubIssueClient {
  return {
    listIssues: vi.fn(async () => pages.shift() ?? []),
    createIssue: vi.fn(async (_repository, draft) => record(draft.body)),
  };
}

describe('GitHub Issue adapter', () => {
  it('TC-AUTO-GHISSUE-127-02..03 marker 确定且同内容远端复用', async () => {
    const draft = buildGitHubIssueDraft(input());
    expect(draft.body).toMatch(
      /^<!-- marketing-ops-issue:v1 campaign=quick-sort-launch idempotency-sha256=[a-f0-9]{64} content-sha256=[a-f0-9]{64} -->/,
    );
    expect(draft.body).toContain('## Sources');

    const remote = client([[record(draft.body)]]);
    const adapter = new GitHubIssueAdapter({ client: remote, repository: REPOSITORY });
    await expect(adapter.create(input())).resolves.toMatchObject({
      issue: record(draft.body),
      receipt: {
        campaignId: 'quick-sort-launch',
        channel: 'github',
        postId: '12',
        publicUrl: expect.stringContaining('/issues/12'),
        adapterVersion: 'github-issue@1.0.0',
        status: 'published',
      },
      reused: true,
    });
    expect(remote.createIssue).not.toHaveBeenCalled();
  });

  it('TC-AUTO-GHISSUE-127-03..04 异内容冲突且有界 lookup 未穷尽时禁止 create', async () => {
    const original = buildGitHubIssueDraft(input());
    const changed = buildGitHubIssueDraft(input({ body: 'Different content.' }));
    const conflictBody = original.body.replace(
      /content-sha256=[a-f0-9]{64}/,
      changed.body.match(/content-sha256=[a-f0-9]{64}/)?.[0] ?? '',
    );
    const conflictClient = client([[record(conflictBody)]]);
    const conflict = new GitHubIssueAdapter({
      client: conflictClient,
      repository: REPOSITORY,
    });
    await expect(conflict.create(input())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    const unrelated = Array.from({ length: 100 }, (_, index) => record(`Unrelated issue ${index}`));
    const boundedClient = client(Array.from({ length: 10 }, () => unrelated));
    const bounded = new GitHubIssueAdapter({ client: boundedClient, repository: REPOSITORY });
    await expect(bounded.create(input())).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });
    expect(boundedClient.createIssue).not.toHaveBeenCalled();
  });

  it('TC-AUTO-GHISSUE-127-04..06 create 结果对拍且 reply 保持禁用', async () => {
    const healthy = client();
    const adapter = new GitHubIssueAdapter({ client: healthy, repository: REPOSITORY });
    await expect(adapter.create(input())).resolves.toMatchObject({
      issue: { number: 12, htmlUrl: expect.stringContaining('/issues/12') },
      receipt: { postId: '12', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      reused: false,
    });
    expect(adapter.capabilities).toEqual({ create: true, comments: true, reply: false });

    const invalid: GitHubIssueClient = {
      listIssues: vi.fn(async () => []),
      createIssue: vi.fn(async () => record('GitHub dropped the marker')),
    };
    await expect(
      new GitHubIssueAdapter({ client: invalid, repository: REPOSITORY }).create(input()),
    ).rejects.toMatchObject({ code: 'UNKNOWN_RESULT', lookupRequired: true });
  });

  it('TC-AUTO-GHISSUE-127-03..05 仓库与读写 transport 错误失败关闭且不泄漏原文', async () => {
    expect(() => new GitHubIssueAdapter({ client: client(), repository: 'invalid' })).toThrow(
      /owner\/name/,
    );

    const readFailure: GitHubIssueClient = {
      listIssues: vi.fn(async () => {
        throw new AdapterTransportError('Bearer private-token', {
          status: 401,
          stage: 'before-submit',
        });
      }),
      createIssue: vi.fn(async (_repository, draft) => record(draft.body)),
    };
    await expect(
      new GitHubIssueAdapter({ client: readFailure, repository: REPOSITORY }).create(input()),
    ).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
      message: expect.not.stringContaining('token'),
    });

    const writeFailure: GitHubIssueClient = {
      listIssues: vi.fn(async () => []),
      createIssue: vi.fn(async () => {
        throw new AdapterTransportError('private stderr', {
          status: 503,
          stage: 'after-submit',
        });
      }),
    };
    await expect(
      new GitHubIssueAdapter({ client: writeFailure, repository: REPOSITORY }).create(input()),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
      message: expect.not.stringContaining('private'),
    });
  });
});
