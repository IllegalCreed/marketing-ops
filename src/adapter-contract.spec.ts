import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  AdapterTransportError,
  createPublishedReceipt,
  defineAdapter,
  mapAdapterTransportError,
  parseAdapterPublishInput,
  requireAdapterCapability,
} from './adapters/contract.js';
import { createAdapterPublishInput, createGitHubPackage } from './test-fixtures.js';

const DEFINITION = {
  channel: 'github' as const,
  version: 'github-release@1.0.0',
  capabilities: {
    publish: true,
    status: true,
    metrics: false,
    feedback: false,
    reply: false,
    delete: true,
  },
};

describe('shared channel adapter contract', () => {
  it('TC-AUTO-ADAPTER-127-01 元数据稳定且未声明能力失败关闭', () => {
    const definition = defineAdapter(DEFINITION);

    expect(definition).toEqual(DEFINITION);
    expect(() => requireAdapterCapability(definition, 'publish')).not.toThrow();
    expect(() => requireAdapterCapability(definition, 'feedback')).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATION', retryable: false }),
    );
    expect(() => defineAdapter({ ...DEFINITION, version: 'latest' })).toThrow(/version/i);
  });

  it('TC-AUTO-ADAPTER-127-02 发布输入严格校验渠道、格式、hash 与媒体', () => {
    const input = createAdapterPublishInput();

    expect(parseAdapterPublishInput(input, { channel: 'github', format: 'release' })).toEqual(
      input,
    );
    expect(() =>
      parseAdapterPublishInput(
        { ...input, package: { ...input.package, channel: 'dev' } },
        { channel: 'github', format: 'release' },
      ),
    ).toThrow(/channel/i);
    expect(() =>
      parseAdapterPublishInput(
        { ...input, contentHash: 'not-a-hash' },
        { channel: 'github', format: 'release' },
      ),
    ).toThrow(/hash/i);
    expect(() =>
      parseAdapterPublishInput(
        { ...input, package: { ...input.package, format: 'article' } },
        { channel: 'github', format: 'release' },
      ),
    ).toThrow(/format/i);
    expect(() =>
      parseAdapterPublishInput(
        { ...input, package: createGitHubPackage(['image']) },
        { channel: 'github', format: 'release', allowUnresolvedMedia: false },
      ),
    ).toThrowError(expect.objectContaining({ code: 'UNRESOLVED_MEDIA' }));
  });

  it('TC-AUTO-ADAPTER-127-03 成功 receipt 只含公开可审计字段', () => {
    const receipt = createPublishedReceipt(createAdapterPublishInput(), DEFINITION.version, {
      postId: '123',
      publicUrl:
        'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Fquick-sort-launch',
      publishedAt: '2026-07-11T00:00:00.000Z',
    });

    expect(receipt).toEqual({
      schemaVersion: 1,
      campaignId: 'quick-sort-launch',
      channel: 'github',
      postId: '123',
      publicUrl:
        'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/marketing%2Fquick-sort-launch',
      publishedAt: '2026-07-11T00:00:00.000Z',
      contentHash: 'a'.repeat(64),
      idempotencyKey: 'campaign-v2/quick-sort-launch/abc12345/github',
      adapterVersion: 'github-release@1.0.0',
      status: 'published',
    });
    expect(JSON.stringify(receipt)).not.toMatch(/authorization|bearer|cookie|header|token/i);

    expect(() =>
      createPublishedReceipt(createAdapterPublishInput(), DEFINITION.version, {
        postId: '',
        publicUrl: 'http://example.com/release',
        publishedAt: '2026-07-11T00:00:00.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'UNKNOWN_RESULT', lookupRequired: true }));
    expect(() =>
      createPublishedReceipt(createAdapterPublishInput(), DEFINITION.version, {
        postId: '123',
        publicUrl: 'https://example.com/release',
        publishedAt: 'not-a-date',
      }),
    ).toThrowError(expect.objectContaining({ code: 'UNKNOWN_RESULT', lookupRequired: true }));
  });

  it('TC-AUTO-ADAPTER-127-05 认证失败映射 REAUTH_REQUIRED 且不泄漏上游消息', () => {
    const error = mapAdapterTransportError(
      new AdapterTransportError('GitHub said Bearer private-token', {
        status: 401,
        stage: 'before-submit',
      }),
    );

    expect(error).toMatchObject({ code: 'REAUTH_REQUIRED', retryable: false });
    expect(JSON.stringify(error)).not.toContain('private-token');

    const existing = new AdapterError('INVALID_CONTENT', 'safe', { retryable: false });
    expect(mapAdapterTransportError(existing)).toBe(existing);
    expect(mapAdapterTransportError(new Error('Bearer private-token'))).toMatchObject({
      code: 'TEMPORARY_FAILURE',
      retryable: true,
      stage: 'before-submit',
    });
  });

  it('TC-AUTO-ADAPTER-127-06 403 与 429 分别映射权限和受限重试时间', () => {
    expect(
      mapAdapterTransportError(
        new AdapterTransportError('forbidden', { status: 403, stage: 'before-submit' }),
      ),
    ).toMatchObject({ code: 'PERMISSION_DENIED', retryable: false });

    expect(
      mapAdapterTransportError(
        new AdapterTransportError('limited', {
          status: 429,
          stage: 'before-submit',
          retryAfterSeconds: 999_999,
        }),
      ),
    ).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 86_400 });
    expect(
      mapAdapterTransportError(
        new AdapterTransportError('limited', { status: 429, stage: 'before-submit' }),
      ),
    ).toMatchObject({ retryAfterSeconds: 60 });
    expect(
      mapAdapterTransportError(
        new AdapterTransportError('limited', {
          status: 429,
          stage: 'before-submit',
          retryAfterSeconds: -10,
        }),
      ),
    ).toMatchObject({ retryAfterSeconds: 1 });
  });

  it('TC-AUTO-ADAPTER-127-07 5xx 与提交前超时映射临时失败', () => {
    for (const error of [
      new AdapterTransportError('service unavailable', {
        status: 503,
        stage: 'before-submit',
      }),
      new AdapterTransportError('timeout', { timeout: true, stage: 'before-submit' }),
    ]) {
      expect(mapAdapterTransportError(error)).toMatchObject({
        code: 'TEMPORARY_FAILURE',
        retryable: true,
        stage: 'before-submit',
      });
    }
    expect(
      mapAdapterTransportError(
        new AdapterTransportError('unexpected status', {
          status: 418,
          stage: 'before-submit',
        }),
      ),
    ).toMatchObject({ code: 'TEMPORARY_FAILURE', retryable: true });
  });

  it('TC-AUTO-ADAPTER-127-08 提交后未知结果禁止盲目重试', () => {
    const error = mapAdapterTransportError(
      new AdapterTransportError('connection dropped', { timeout: true, stage: 'after-submit' }),
    );

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({
      code: 'UNKNOWN_RESULT',
      retryable: false,
      stage: 'after-submit',
      lookupRequired: true,
    });
  });
});
