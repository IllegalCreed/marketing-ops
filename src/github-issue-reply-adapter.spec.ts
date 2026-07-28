import { describe, expect, it, vi } from 'vitest';
import { AdapterTransportError } from './adapters/contract.js';
import {
  GitHubIssueReplyAdapter,
  type GitHubIssueReplyClient,
} from './adapters/github-issue-reply.js';

const REPOSITORY = 'IllegalCreed/algorithms-visualization';
const ISSUE_URL = `https://github.com/${REPOSITORY}/issues/12`;

function comment(body: string, id = 21) {
  return {
    id,
    htmlUrl: `${ISSUE_URL}#issuecomment-${id}`,
    body,
    userLogin: 'reader',
    createdAt: '2026-07-28T01:00:00Z',
    updatedAt: '2026-07-28T01:00:00Z',
  };
}

function client(existing: ReturnType<typeof comment>[] = []): GitHubIssueReplyClient {
  return {
    listIssueComments: vi.fn(async () => existing),
    createIssueComment: vi.fn(async (_repository, _issueNumber, body) => comment(body, 22)),
  };
}

const INPUT = {
  projectId: 'algorithm-visualizer',
  campaignId: 'quick-sort-launch',
  issueNumber: 12,
  issueUrl: ISSUE_URL,
  sourceCommentId: 'issue-comment:21',
  body: 'Thanks for the feedback.',
  idempotencyKey: 'reply/quick-sort-launch/issue-comment-21',
};

describe('GitHub Issue FAQ reply adapter', () => {
  it('TC-AUTO-GHREPLY-127-01 repository 与 Issue URL 必须精确匹配', async () => {
    expect(
      () => new GitHubIssueReplyAdapter({ client: client(), repository: 'not-a-repository' }),
    ).toThrow(/owner\/name/i);
    await expect(
      new GitHubIssueReplyAdapter({ client: client(), repository: REPOSITORY }).reply({
        ...INPUT,
        issueUrl: `https://github.com/${REPOSITORY}/issues/13`,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });
  });

  it('TC-AUTO-GHREPLY-127-01..03 marker 确定、远端复用且不重复 create', async () => {
    const transport = client();
    const adapter = new GitHubIssueReplyAdapter({ client: transport, repository: REPOSITORY });
    const first = await adapter.reply(INPUT);
    expect(first).toMatchObject({
      reused: false,
      receipt: {
        channel: 'github',
        adapterVersion: 'github-issue-reply@1.0.0',
        status: 'published',
      },
    });
    const createdBody = vi.mocked(transport.createIssueComment).mock.calls[0]?.[2];
    expect(createdBody).toMatch(/^<!-- marketing-ops-reply:v1 /);

    const replayClient = client([comment(createdBody ?? '', 22)]);
    await expect(
      new GitHubIssueReplyAdapter({ client: replayClient, repository: REPOSITORY }).reply(INPUT),
    ).resolves.toMatchObject({ reused: true, receipt: { postId: '22' } });
    expect(replayClient.createIssueComment).not.toHaveBeenCalled();
  });

  it('TC-AUTO-GHREPLY-127-03 异内容 marker 冲突失败关闭', async () => {
    const transport = client();
    const adapter = new GitHubIssueReplyAdapter({ client: transport, repository: REPOSITORY });
    await adapter.reply(INPUT);
    const createdBody = vi.mocked(transport.createIssueComment).mock.calls[0]?.[2] ?? '';
    const conflicting = createdBody.replace(
      /content-sha256=[a-f0-9]{64}/,
      `content-sha256=${'b'.repeat(64)}`,
    );

    await expect(
      new GitHubIssueReplyAdapter({
        client: client([comment(conflicting, 22)]),
        repository: REPOSITORY,
      }).reply(INPUT),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('TC-AUTO-GHREPLY-127-04..05 结果对拍与 transport 错误脱敏', async () => {
    const invalid: GitHubIssueReplyClient = {
      listIssueComments: vi.fn(async () => []),
      createIssueComment: vi.fn(async () => comment('marker dropped', 22)),
    };
    await expect(
      new GitHubIssueReplyAdapter({ client: invalid, repository: REPOSITORY }).reply(INPUT),
    ).rejects.toMatchObject({ code: 'UNKNOWN_RESULT', lookupRequired: true });

    const failure: GitHubIssueReplyClient = {
      listIssueComments: vi.fn(async () => []),
      createIssueComment: vi.fn(async () => {
        throw new AdapterTransportError('Bearer private-token', {
          status: 503,
          stage: 'after-submit',
        });
      }),
    };
    await expect(
      new GitHubIssueReplyAdapter({ client: failure, repository: REPOSITORY }).reply(INPUT),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      message: expect.not.stringContaining('token'),
    });

    const lookupFailure: GitHubIssueReplyClient = {
      listIssueComments: vi.fn(async () => {
        throw new AdapterTransportError('Bearer private-token', {
          status: 503,
          stage: 'before-submit',
        });
      }),
      createIssueComment: vi.fn(),
    };
    await expect(
      new GitHubIssueReplyAdapter({
        client: lookupFailure,
        repository: REPOSITORY,
      }).reply(INPUT),
    ).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
      message: expect.not.stringContaining('token'),
    });

    const fullPage = Array.from({ length: 100 }, (_, index) =>
      comment(`unrelated ${index}`, index + 1),
    );
    const bounded = client(fullPage);
    await expect(
      new GitHubIssueReplyAdapter({ client: bounded, repository: REPOSITORY }).reply(INPUT),
    ).rejects.toMatchObject({ code: 'UNKNOWN_RESULT', lookupRequired: true });
    expect(bounded.listIssueComments).toHaveBeenCalledTimes(10);
    expect(bounded.createIssueComment).not.toHaveBeenCalled();
  });
});
