import { describe, expect, it, vi } from 'vitest';
import { AdapterTransportError, requireAdapterCapability } from './adapters/contract.js';
import {
  buildGitHubReleaseDraft,
  GitHubReleaseAdapter,
  type GitHubReleaseClient,
  type GitHubReleaseRecord,
} from './adapters/github-release.js';
import { createAdapterPublishInput, createGitHubPackage } from './test-fixtures.js';

function createRecord(body: string): GitHubReleaseRecord {
  return {
    id: 123,
    tagName: 'marketing/quick-sort-launch',
    name: '快速排序可视化已上线 / Quick Sort visualization is live',
    body,
    htmlUrl:
      'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Fquick-sort-launch',
    publishedAt: '2026-07-11T00:00:00.000Z',
  };
}

function createClient(record: GitHubReleaseRecord | null = null) {
  return {
    findReleaseByTag: vi.fn<GitHubReleaseClient['findReleaseByTag']>().mockResolvedValue(record),
    createRelease: vi
      .fn<GitHubReleaseClient['createRelease']>()
      .mockImplementation(async (_repository, input) => createRecord(input.body)),
    deleteRelease: vi.fn<GitHubReleaseClient['deleteRelease']>().mockResolvedValue('deleted'),
    findTagReference: vi.fn(
      async () => null as { ref: string; sha: string; type: 'commit' | 'tag' } | null,
    ),
    deleteTagReference: vi.fn(async () => 'deleted' as 'deleted' | 'not-found'),
  };
}

function createAdapter(client: GitHubReleaseClient) {
  return new GitHubReleaseAdapter({
    client,
    repository: 'IllegalCreed/algorithms-visualization',
  });
}

describe('GitHub Release adapter with typed fake client', () => {
  it('TC-AUTO-GITHUB-127-01 双语 Release draft 与公开 marker 确定', () => {
    const input = createAdapterPublishInput();
    const first = buildGitHubReleaseDraft(input);
    const second = buildGitHubReleaseDraft(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      tagName: 'marketing/quick-sort-launch',
      name: '快速排序可视化已上线 / Quick Sort visualization is live',
      draft: false,
      prerelease: false,
    });
    expect(first.body).toMatch(/marketing-ops:v1.*content-sha256=[a-f0-9]{64}/);
    expect(first.body).toContain('## 中文');
    expect(first.body).toContain('## English');
    expect(first.body).not.toContain(input.idempotencyKey);
  });

  it('TC-AUTO-ADAPTER-127-04 / TC-AUTO-GITHUB-127-02 已存在同内容时幂等复用', async () => {
    const input = createAdapterPublishInput();
    const existing = createRecord(buildGitHubReleaseDraft(input).body);
    const client = createClient(existing);

    const result = await createAdapter(client).publish(input);

    expect(result).toMatchObject({ reused: true, receipt: { postId: '123', status: 'published' } });
    expect(client.findReleaseByTag).toHaveBeenCalledOnce();
    expect(client.createRelease).not.toHaveBeenCalled();
  });

  it('TC-AUTO-GITHUB-127-03 同 tag 异内容失败关闭', async () => {
    const client = createClient(createRecord('A release created by something else.'));

    await expect(createAdapter(client).publish(createAdapterPublishInput())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      retryable: false,
    });
    expect(client.createRelease).not.toHaveBeenCalled();
    expect(
      () =>
        new GitHubReleaseAdapter({
          client,
          repository: 'IllegalCreed/algorithms-visualization;rm',
        }),
    ).toThrow(/owner\/name/i);
  });

  it('TC-AUTO-GITHUB-127-04 创建成功映射 receipt 且 client 接收结构化参数', async () => {
    const client = createClient();

    const result = await createAdapter(client).publish(createAdapterPublishInput());

    expect(result).toMatchObject({
      reused: false,
      receipt: {
        channel: 'github',
        postId: '123',
        adapterVersion: 'github-release@1.2.0',
        status: 'published',
      },
    });
    expect(client.createRelease).toHaveBeenCalledWith(
      'IllegalCreed/algorithms-visualization',
      expect.objectContaining({ tagName: 'marketing/quick-sort-launch' }),
    );
    expect(client.createRelease.mock.calls[0]?.[1]).not.toHaveProperty('command');
    expect(client.createRelease.mock.calls[0]?.[1]).not.toHaveProperty('args');
  });

  it('TC-AUTO-GHSMOKE-127-01 不复用无法证明归属的既有 tag', async () => {
    const client = createClient();
    client.findTagReference.mockResolvedValueOnce({
      ref: 'refs/tags/marketing/quick-sort-launch',
      sha: 'a'.repeat(40),
      type: 'commit',
    });

    await expect(createAdapter(client).publish(createAdapterPublishInput())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(client.createRelease).not.toHaveBeenCalled();
  });

  it('TC-AUTO-GITHUB-127-04 认证与提交后未知结果沿共享错误合同映射', async () => {
    const authClient = createClient();
    authClient.findReleaseByTag.mockRejectedValueOnce(
      new AdapterTransportError('Bearer private-token', {
        status: 401,
        stage: 'before-submit',
      }),
    );
    await expect(
      createAdapter(authClient).publish(createAdapterPublishInput()),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });

    const unknownClient = createClient();
    unknownClient.createRelease.mockRejectedValueOnce(
      new AdapterTransportError('connection dropped', {
        timeout: true,
        stage: 'after-submit',
      }),
    );
    await expect(
      createAdapter(unknownClient).publish(createAdapterPublishInput()),
    ).rejects.toMatchObject({ code: 'UNKNOWN_RESULT', lookupRequired: true });

    const externalClient = createClient();
    const draft = buildGitHubReleaseDraft(createAdapterPublishInput());
    externalClient.createRelease.mockResolvedValueOnce({
      ...createRecord(draft.body),
      htmlUrl: 'https://github.com/someone-else/repository/releases/tag/untrusted',
    });
    await expect(
      createAdapter(externalClient).publish(createAdapterPublishInput()),
    ).rejects.toMatchObject({ code: 'UNKNOWN_RESULT', lookupRequired: true });
  });

  it('TC-AUTO-GITHUB-127-05 未解析媒体在任何 client 调用前拒绝', async () => {
    const client = createClient();
    const input = createAdapterPublishInput();

    await expect(
      createAdapter(client).publish({
        ...input,
        package: createGitHubPackage(['image']),
      }),
    ).rejects.toMatchObject({ code: 'UNRESOLVED_MEDIA' });
    expect(client.findReleaseByTag).not.toHaveBeenCalled();
    expect(client.createRelease).not.toHaveBeenCalled();
  });

  it('TC-AUTO-GITHUB-127-06 只删除 receipt 指向的 Release 且重复删除幂等', async () => {
    const client = createClient();
    const adapter = createAdapter(client);
    const receipt = (await adapter.publish(createAdapterPublishInput())).receipt;
    const remote = createRecord(buildGitHubReleaseDraft(createAdapterPublishInput()).body);
    client.findReleaseByTag.mockResolvedValueOnce(remote).mockResolvedValueOnce(null);

    await expect(adapter.delete(receipt)).resolves.toEqual({ status: 'deleted' });
    client.deleteTagReference.mockResolvedValueOnce('not-found');
    await expect(adapter.delete(receipt)).resolves.toEqual({ status: 'already-deleted' });
    expect(client.deleteRelease).toHaveBeenNthCalledWith(
      1,
      'IllegalCreed/algorithms-visualization',
      123,
    );
    expect(client.deleteTagReference).toHaveBeenNthCalledWith(
      1,
      'IllegalCreed/algorithms-visualization',
      'marketing/quick-sort-launch',
    );

    await expect(adapter.delete({ ...receipt, postId: 'not-a-number' })).rejects.toMatchObject({
      code: 'INVALID_CONTENT',
    });
    client.deleteRelease.mockRejectedValueOnce(
      new AdapterTransportError('forbidden', { status: 403, stage: 'before-submit' }),
    );
    client.findReleaseByTag.mockResolvedValueOnce(remote);
    await expect(adapter.delete(receipt)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('TC-AUTO-GITHUB-127-06 删除前对拍 marker，tag 清理失败时保留可重试状态', async () => {
    const client = createClient();
    const adapter = createAdapter(client);
    const receipt = (await adapter.publish(createAdapterPublishInput())).receipt;
    client.findReleaseByTag.mockResolvedValueOnce(createRecord('Different marker'));
    await expect(adapter.delete(receipt)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(client.deleteRelease).not.toHaveBeenCalled();
    expect(client.deleteTagReference).not.toHaveBeenCalled();

    client.findReleaseByTag.mockResolvedValueOnce(null);
    client.deleteTagReference.mockRejectedValueOnce(
      new AdapterTransportError('temporary failure', { status: 503, stage: 'after-submit' }),
    );
    await expect(adapter.delete(receipt)).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      lookupRequired: true,
    });
  });

  it('TC-AUTO-GITHUB-127-07 / GHISSUE-127-06 collector 可读但自动回复保持关闭', () => {
    const definition = createAdapter(createClient()).definition;

    expect(definition.capabilities).toMatchObject({
      publish: true,
      status: true,
      metrics: true,
      feedback: true,
      reply: false,
      delete: true,
    });
    expect(() => requireAdapterCapability(definition, 'metrics')).not.toThrow();
    expect(() => requireAdapterCapability(definition, 'feedback')).not.toThrow();
    expect(() => requireAdapterCapability(definition, 'reply')).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
    );
  });
});
