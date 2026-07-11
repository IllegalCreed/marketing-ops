import { describe, expect, it, vi } from 'vitest';
import { AdapterError, AdapterTransportError } from './adapters/contract.js';
import {
  buildGitHubCliInvocation,
  GitHubCliClient,
  GitHubCliProcessTransport,
  type GitHubCliTransport,
} from './adapters/github-cli.js';
import { buildGitHubReleaseDraft } from './adapters/github-release.js';
import type { GhProcessResult } from './runtime/gh-process.js';
import { createAdapterPublishInput } from './test-fixtures.js';

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

function releaseJson() {
  return JSON.stringify({
    id: 123,
    tagName: 'marketing/quick-sort-launch',
    name: 'Quick Sort visualization',
    body: '<!-- marker -->',
    htmlUrl:
      'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Fquick-sort-launch',
    publishedAt: '2026-07-11T00:00:00Z',
  });
}

describe('typed GitHub CLI client', () => {
  it('TC-AUTO-GHCLI-127-01 只映射固定 API 操作且禁止任意执行面', () => {
    const authStatus = buildGitHubCliInvocation({ operation: 'auth-status' });
    expect(authStatus.args).toEqual(['auth', 'status', '--active', '--hostname', 'github.com']);
    expect(authStatus.args.join(' ')).not.toMatch(/token|show-token|verbose/i);

    const invocations = [
      buildGitHubCliInvocation({ operation: 'viewer' }),
      buildGitHubCliInvocation({ operation: 'repository', repository: REPOSITORY }),
      buildGitHubCliInvocation({
        operation: 'find-release',
        repository: REPOSITORY,
        tagName: 'marketing/quick-sort-launch',
      }),
      buildGitHubCliInvocation({
        operation: 'delete-release',
        repository: REPOSITORY,
        releaseId: 123,
      }),
    ];

    for (const invocation of invocations) {
      expect(invocation.args[0]).toBe('api');
      expect(invocation.args.join(' ')).not.toMatch(
        /auth|token|show-token|include|verbose|graphql|--input\s+(?!-)/i,
      );
      expect(invocation).toMatchObject({ timeoutMs: 20_000, maxOutputBytes: 524_288 });
    }
    expect(() =>
      buildGitHubCliInvocation({ operation: 'viewer', endpoint: 'user/emails' } as never),
    ).toThrow();
    expect(() =>
      buildGitHubCliInvocation({
        operation: 'find-release',
        repository: 'IllegalCreed/repo;rm',
        tagName: 'marketing/quick-sort-launch',
      }),
    ).toThrow();
  });

  it('TC-AUTO-GHCLI-127-01 process transport 只执行构造后的固定 invocation', async () => {
    const expected = result({ stdout: '{"login":"IllegalCreed"}' });
    const runner = vi.fn(async () => expected);
    const processTransport = new GitHubCliProcessTransport(runner);

    await expect(processTransport.run({ operation: 'viewer' })).resolves.toBe(expected);
    expect(runner).toHaveBeenCalledWith(buildGitHubCliInvocation({ operation: 'viewer' }));
  });

  it('TC-AUTO-GHCLI-127-02 Release 正文只进入 stdin JSON', () => {
    const draft = buildGitHubReleaseDraft(createAdapterPublishInput());
    const invocation = buildGitHubCliInvocation({
      operation: 'create-release',
      repository: REPOSITORY,
      release: draft,
    });
    const argv = invocation.args.join(' ');
    const body = JSON.parse(invocation.stdin ?? '{}') as Record<string, unknown>;

    expect(argv).toContain('--input -');
    expect(argv).not.toContain(draft.name);
    expect(argv).not.toContain(draft.body);
    expect(body).toEqual({
      tag_name: draft.tagName,
      name: draft.name,
      body: draft.body,
      draft: false,
      prerelease: false,
    });
  });

  it('TC-AUTO-GHCLI-127-03 严格解析 viewer、repository 与 Release', async () => {
    const mock = transport(
      result({ stdout: '{"login":"IllegalCreed"}' }),
      result({
        stdout:
          '{"fullName":"IllegalCreed/algorithms-visualization","archived":false,"disabled":false,"permissions":{"admin":true,"maintain":true,"push":true}}',
      }),
      result({ stdout: releaseJson() }),
      result({ stdout: releaseJson() }),
    );
    const client = new GitHubCliClient(mock);

    await expect(client.getViewer()).resolves.toEqual({ login: 'IllegalCreed' });
    await expect(client.getRepository(REPOSITORY)).resolves.toMatchObject({
      fullName: REPOSITORY,
      permissions: { push: true },
    });
    await expect(
      client.findReleaseByTag(REPOSITORY, 'marketing/quick-sort-launch'),
    ).resolves.toMatchObject({ id: 123, tagName: 'marketing/quick-sort-launch' });
    await expect(
      client.createRelease(REPOSITORY, buildGitHubReleaseDraft(createAdapterPublishInput())),
    ).resolves.toMatchObject({ id: 123 });

    const malformed = new GitHubCliClient(
      transport(result({ stdout: '{"login":"IllegalCreed","token":"private"}' })),
    );
    await expect(malformed.getViewer()).rejects.toMatchObject({
      code: 'TEMPORARY_FAILURE',
    });
  });

  it('TC-AUTO-GHCLI-127-04 GET/DELETE 404 使用幂等不存在语义', async () => {
    const mock = transport(
      result({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' }),
      result({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' }),
      result(),
    );
    const client = new GitHubCliClient(mock);

    await expect(
      client.findReleaseByTag(REPOSITORY, 'marketing/quick-sort-launch'),
    ).resolves.toBeNull();
    await expect(client.deleteRelease(REPOSITORY, 123)).resolves.toBe('not-found');
    await expect(client.deleteRelease(REPOSITORY, 123)).resolves.toBe('deleted');
  });

  it('TC-AUTO-GHCLI-127-05 错误保留类别但不泄漏 stderr', async () => {
    const auth = new GitHubCliClient(
      transport(result({ exitCode: 1, stderr: 'Bearer private-token (HTTP 401)' })),
    );
    const authError = await auth.getViewer().catch((error: unknown) => error);
    expect(authError).toMatchObject({ status: 401 });
    expect(JSON.stringify(authError)).not.toContain('private-token');

    const limited = new GitHubCliClient(
      transport(result({ exitCode: 1, stderr: 'Retry-After: 120 (HTTP 429)' })),
    );
    await expect(limited.getViewer()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 120,
    });

    const uncertain = new GitHubCliClient(transport(result({ exitCode: null, timedOut: true })));
    await expect(
      uncertain.createRelease(REPOSITORY, buildGitHubReleaseDraft(createAdapterPublishInput())),
    ).rejects.toMatchObject({ timeout: true, stage: 'after-submit' });

    expect(new AdapterError('INVALID_CONTENT', 'safe', { retryable: false })).toBeInstanceOf(Error);
    expect(new AdapterTransportError('safe', { stage: 'before-submit' })).toBeInstanceOf(Error);
  });

  it('TC-AUTO-GHCLI-127-03/05 超限、422 与畸形写响应保持失败关闭', async () => {
    const readLimit = new GitHubCliClient(
      transport(result({ exitCode: null, outputLimitExceeded: true })),
    );
    await expect(readLimit.getViewer()).rejects.toMatchObject({ status: 502 });

    const oversized = new GitHubCliClient(transport(result({ stdout: 'x'.repeat(524_289) })));
    await expect(oversized.getViewer()).rejects.toMatchObject({ status: 502 });

    const draft = buildGitHubReleaseDraft(createAdapterPublishInput());
    const writeLimit = new GitHubCliClient(
      transport(result({ exitCode: null, outputLimitExceeded: true })),
    );
    await expect(writeLimit.createRelease(REPOSITORY, draft)).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });

    const invalidContent = new GitHubCliClient(
      transport(result({ exitCode: 1, stderr: 'Validation Failed (HTTP 422)' })),
    );
    await expect(invalidContent.createRelease(REPOSITORY, draft)).rejects.toMatchObject({
      code: 'INVALID_CONTENT',
    });

    const malformedWrite = new GitHubCliClient(transport(result({ stdout: '{broken' })));
    await expect(malformedWrite.createRelease(REPOSITORY, draft)).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });

    const unknownWrite = new GitHubCliClient(
      transport(result({ exitCode: 1, stderr: 'unclassified CLI failure' })),
    );
    await expect(unknownWrite.createRelease(REPOSITORY, draft)).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });

    const forbidden = new GitHubCliClient(
      transport(result({ exitCode: 1, stderr: 'Forbidden (HTTP 403)' })),
    );
    await expect(
      forbidden.findReleaseByTag(REPOSITORY, 'marketing/quick-sort-launch'),
    ).rejects.toMatchObject({ status: 403, stage: 'before-submit' });

    const missing = new GitHubCliClient(
      transport(result({ exitCode: null, spawnError: 'not-found' })),
    );
    await expect(missing.getViewer()).rejects.toMatchObject({
      name: 'GitHubCliUnavailableError',
      reason: 'not-found',
    });

    const unclassifiedRead = new GitHubCliClient(
      transport(result({ exitCode: 1, stderr: 'safe CLI failure' })),
    );
    await expect(unclassifiedRead.getViewer()).rejects.toMatchObject({
      stage: 'before-submit',
    });
  });

  it('TC-AUTO-GHAUTH-127-01..04 健康检查区分 ready、缺 CLI、重授权与阻塞', async () => {
    const ready = new GitHubCliClient(
      transport(
        result(),
        result({ stdout: '{"login":"IllegalCreed"}' }),
        result({
          stdout:
            '{"fullName":"IllegalCreed/algorithms-visualization","archived":false,"disabled":false,"permissions":{"admin":false,"maintain":false,"push":true}}',
        }),
      ),
    );
    await expect(ready.checkHealth(REPOSITORY)).resolves.toEqual({
      alias: 'IllegalCreed',
      health: 'ready',
      reason: 'READY',
    });

    const missing = new GitHubCliClient(
      transport(result({ exitCode: null, spawnError: 'not-found' })),
    );
    await expect(missing.checkHealth(REPOSITORY)).resolves.toMatchObject({
      alias: null,
      health: 'not-configured',
      reason: 'CLI_NOT_FOUND',
    });

    const reauth = new GitHubCliClient(
      transport(result({ exitCode: 1, stderr: 'private CLI auth details' })),
    );
    await expect(reauth.checkHealth(REPOSITORY)).resolves.toMatchObject({
      health: 'reauth-required',
      reason: 'REAUTH_REQUIRED',
    });

    const repositoryReauth = new GitHubCliClient(
      transport(
        result(),
        result({ stdout: '{"login":"IllegalCreed"}' }),
        result({ exitCode: 1, stderr: 'expired (HTTP 401)' }),
      ),
    );
    await expect(repositoryReauth.checkHealth(REPOSITORY)).resolves.toMatchObject({
      alias: null,
      health: 'reauth-required',
      reason: 'REAUTH_REQUIRED',
    });

    const failedCli = new GitHubCliClient(
      transport(result({ exitCode: null, spawnError: 'failed' })),
    );
    await expect(failedCli.checkHealth(REPOSITORY)).resolves.toMatchObject({
      health: 'blocked',
      reason: 'TEMPORARY_FAILURE',
    });

    const disappearedAfterAuth = new GitHubCliClient(
      transport(result(), result({ exitCode: null, spawnError: 'not-found' })),
    );
    await expect(disappearedAfterAuth.checkHealth(REPOSITORY)).resolves.toMatchObject({
      health: 'not-configured',
      reason: 'CLI_NOT_FOUND',
    });

    const failedAfterAuth = new GitHubCliClient(
      transport(result(), result({ exitCode: 1, stderr: 'safe CLI failure' })),
    );
    await expect(failedAfterAuth.checkHealth(REPOSITORY)).resolves.toMatchObject({
      health: 'blocked',
      reason: 'TEMPORARY_FAILURE',
    });

    for (const repository of [
      {
        fullName: REPOSITORY,
        archived: false,
        disabled: false,
        permissions: { admin: false, maintain: false, push: false },
      },
      {
        fullName: 'someone/else',
        archived: false,
        disabled: false,
        permissions: { admin: true, maintain: true, push: true },
      },
      {
        fullName: REPOSITORY,
        archived: true,
        disabled: false,
        permissions: { admin: true, maintain: true, push: true },
      },
    ]) {
      const blocked = new GitHubCliClient(
        transport(
          result(),
          result({ stdout: '{"login":"IllegalCreed"}' }),
          result({ stdout: JSON.stringify(repository) }),
        ),
      );
      await expect(blocked.checkHealth(REPOSITORY)).resolves.toMatchObject({
        alias: 'IllegalCreed',
        health: 'blocked',
      });
    }
  });
});
