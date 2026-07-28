import { describe, expect, it, vi } from 'vitest';
import {
  buildGitHubCliInvocation,
  GitHubCliClient,
  type GitHubCliTransport,
} from './adapters/github-cli.js';
import type { GhProcessResult } from './runtime/gh-process.js';

const REPOSITORY = 'IllegalCreed/algorithms-visualization';

function result(overrides: Partial<GhProcessResult> = {}): GhProcessResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputLimitExceeded: false,
    spawnError: null,
    ...overrides,
  };
}

function transport(...results: GhProcessResult[]) {
  return {
    run: vi.fn<GitHubCliTransport['run']>(async () => results.shift() ?? result()),
  } satisfies GitHubCliTransport;
}

describe('GitHub observability and Issue CLI operations', () => {
  it('TC-AUTO-GHOBS-127-01 固定 Release/traffic 只读 endpoint 与受支持 API version', () => {
    const invocations = [
      buildGitHubCliInvocation({ operation: 'get-release', repository: REPOSITORY, releaseId: 7 }),
      buildGitHubCliInvocation({
        operation: 'list-release-reactions',
        repository: REPOSITORY,
        releaseId: 7,
        page: 1,
      }),
      buildGitHubCliInvocation({ operation: 'traffic-views', repository: REPOSITORY }),
      buildGitHubCliInvocation({ operation: 'traffic-clones', repository: REPOSITORY }),
      buildGitHubCliInvocation({ operation: 'traffic-referrers', repository: REPOSITORY }),
      buildGitHubCliInvocation({ operation: 'traffic-paths', repository: REPOSITORY }),
    ];

    expect(invocations.map((item) => item.args[1])).toEqual([
      `repos/${REPOSITORY}/releases/7`,
      `repos/${REPOSITORY}/releases/7/reactions?per_page=100&page=1`,
      `repos/${REPOSITORY}/traffic/views?per=day`,
      `repos/${REPOSITORY}/traffic/clones?per=day`,
      `repos/${REPOSITORY}/traffic/popular/referrers`,
      `repos/${REPOSITORY}/traffic/popular/paths`,
    ]);
    for (const invocation of invocations) {
      expect(invocation.args).toContain('X-GitHub-Api-Version: 2026-03-10');
      expect(invocation.args.join(' ')).not.toMatch(/show-token|include|verbose|graphql/i);
      expect(invocation.stdin).toBeNull();
    }
  });

  it('TC-AUTO-GHOBS-127-02..04 严格解析 Release、reactions 与 traffic', async () => {
    const mock = transport(
      result({
        stdout: JSON.stringify({
          id: 7,
          tagName: 'marketing/quick-sort-launch',
          name: 'Quick Sort',
          body: '<!-- marker -->',
          htmlUrl:
            'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Fquick-sort-launch',
          publishedAt: '2026-07-11T00:00:00Z',
          assets: [{ id: 9, name: 'demo.gif', downloadCount: 3 }],
        }),
      }),
      result({
        stdout: JSON.stringify([
          {
            id: 11,
            content: 'rocket',
            userLogin: 'reader',
            createdAt: '2026-07-11T01:00:00Z',
          },
        ]),
      }),
      result({
        stdout: JSON.stringify({
          count: 4,
          uniques: 3,
          points: [{ timestamp: '2026-07-11T00:00:00Z', count: 4, uniques: 3 }],
        }),
      }),
      result({
        stdout: JSON.stringify({
          count: 2,
          uniques: 2,
          points: [{ timestamp: '2026-07-11T00:00:00Z', count: 2, uniques: 2 }],
        }),
      }),
      result({ stdout: '[{"referrer":"Google","count":3,"uniques":2}]' }),
      result({
        stdout:
          '[{"path":"/IllegalCreed/algorithms-visualization","title":"Algorithm Visualizer","count":3,"uniques":2}]',
      }),
    );
    const client = new GitHubCliClient(mock);

    await expect(client.getRelease(REPOSITORY, 7)).resolves.toMatchObject({
      id: 7,
      assets: [{ downloadCount: 3 }],
    });
    await expect(client.listReleaseReactions(REPOSITORY, 7, 1)).resolves.toEqual([
      expect.objectContaining({ content: 'rocket', userLogin: 'reader' }),
    ]);
    await expect(client.getTrafficViews(REPOSITORY)).resolves.toMatchObject({ count: 4 });
    await expect(client.getTrafficClones(REPOSITORY)).resolves.toMatchObject({ count: 2 });
    await expect(client.getTrafficReferrers(REPOSITORY)).resolves.toHaveLength(1);
    await expect(client.getTrafficPaths(REPOSITORY)).resolves.toHaveLength(1);

    const malformed = new GitHubCliClient(
      transport(
        result({
          stdout: '{"count":0,"uniques":0,"points":[],"authorization":"Bearer private"}',
        }),
      ),
    );
    await expect(malformed.getTrafficViews(REPOSITORY)).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
    });
  });

  it('TC-AUTO-GHISSUE-127-01..02 固定 Issue 操作且 create 正文只走 stdin', () => {
    const list = buildGitHubCliInvocation({
      operation: 'list-issues',
      repository: REPOSITORY,
      page: 2,
    });
    const comments = buildGitHubCliInvocation({
      operation: 'list-issue-comments',
      repository: REPOSITORY,
      issueNumber: 12,
      page: 3,
    });
    const create = buildGitHubCliInvocation({
      operation: 'create-issue',
      repository: REPOSITORY,
      issue: { title: 'Bug report', body: '<!-- private-ish marker -->\nBody' },
    });
    const reply = buildGitHubCliInvocation({
      operation: 'create-issue-comment',
      repository: REPOSITORY,
      issueNumber: 12,
      comment: { body: '<!-- reply marker -->\nThanks.' },
    });

    expect(list.args[1]).toBe(
      `repos/${REPOSITORY}/issues?state=all&sort=created&direction=desc&per_page=100&page=2`,
    );
    expect(comments.args[1]).toBe(`repos/${REPOSITORY}/issues/12/comments?per_page=100&page=3`);
    expect(create.args).toContain('--input');
    expect(create.args.join(' ')).not.toContain('private-ish marker');
    expect(JSON.parse(create.stdin ?? '{}')).toEqual({
      title: 'Bug report',
      body: '<!-- private-ish marker -->\nBody',
    });
    expect(reply.args[1]).toBe(`repos/${REPOSITORY}/issues/12/comments`);
    expect(reply.args).toContain('--input');
    expect(reply.args.join(' ')).not.toContain('reply marker');
    expect(JSON.parse(reply.stdin ?? '{}')).toEqual({
      body: '<!-- reply marker -->\nThanks.',
    });
    expect(() =>
      buildGitHubCliInvocation({
        operation: 'list-issues',
        repository: REPOSITORY,
        page: 1,
        query: 'is:issue arbitrary',
      } as never),
    ).toThrow();
  });

  it('TC-AUTO-GHSMOKE-127-01 tag 引用只允许固定 get/delete 路径', () => {
    const get = buildGitHubCliInvocation({
      operation: 'get-tag-reference',
      repository: REPOSITORY,
      tagName: 'marketing/marketing-ops-t3c-smoke-127',
    });
    const remove = buildGitHubCliInvocation({
      operation: 'delete-tag-reference',
      repository: REPOSITORY,
      tagName: 'marketing/marketing-ops-t3c-smoke-127',
    });

    expect(get.args[1]).toBe(
      `repos/${REPOSITORY}/git/ref/tags/marketing/marketing-ops-t3c-smoke-127`,
    );
    expect(remove.args[1]).toBe(
      `repos/${REPOSITORY}/git/refs/tags/marketing/marketing-ops-t3c-smoke-127`,
    );
    expect(get.args).toContain('--jq');
    expect(remove.args).toContain('--silent');
    expect(get.stdin).toBeNull();
    expect(remove.stdin).toBeNull();
  });

  it('TC-AUTO-GHISSUE-127-04..05 严格解析 Issue/create/comments 且未知写结果要求 lookup', async () => {
    const issue = {
      number: 12,
      htmlUrl: 'https://github.com/IllegalCreed/algorithms-visualization/issues/12',
      title: 'Bug report',
      body: '<!-- marker -->\nBody',
      state: 'open',
      createdAt: '2026-07-11T00:00:00Z',
      updatedAt: '2026-07-11T00:00:00Z',
    };
    const mock = transport(
      result({ stdout: JSON.stringify([issue]) }),
      result({ stdout: JSON.stringify(issue) }),
      result({
        stdout: JSON.stringify([
          {
            id: 21,
            htmlUrl:
              'https://github.com/IllegalCreed/algorithms-visualization/issues/12#issuecomment-21',
            body: 'Comment',
            userLogin: null,
            createdAt: '2026-07-11T01:00:00Z',
            updatedAt: '2026-07-11T01:00:00Z',
          },
        ]),
      }),
      result({
        stdout: JSON.stringify({
          id: 22,
          htmlUrl:
            'https://github.com/IllegalCreed/algorithms-visualization/issues/12#issuecomment-22',
          body: '<!-- reply marker -->\nThanks.',
          userLogin: 'IllegalCreed',
          createdAt: '2026-07-11T02:00:00Z',
          updatedAt: '2026-07-11T02:00:00Z',
        }),
      }),
    );
    const client = new GitHubCliClient(mock);

    await expect(client.listIssues(REPOSITORY, 1)).resolves.toEqual([issue]);
    await expect(
      client.createIssue(REPOSITORY, { title: 'Bug report', body: '<!-- marker -->\nBody' }),
    ).resolves.toEqual(issue);
    await expect(client.listIssueComments(REPOSITORY, 12, 1)).resolves.toMatchObject([
      { id: 21, userLogin: null, body: 'Comment' },
    ]);
    await expect(
      client.createIssueComment(REPOSITORY, 12, '<!-- reply marker -->\nThanks.'),
    ).resolves.toMatchObject({ id: 22, userLogin: 'IllegalCreed' });

    const unknown = new GitHubCliClient(
      transport(result({ exitCode: 1, stderr: 'unclassified create failure' })),
    );
    await expect(
      unknown.createIssue(REPOSITORY, { title: 'Bug report', body: '<!-- marker -->\nBody' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_RESULT', lookupRequired: true });
  });
});
