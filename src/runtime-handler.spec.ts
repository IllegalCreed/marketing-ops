import { describe, expect, it, vi } from 'vitest';
import { AdapterError } from './adapters/contract.js';
import { createRuntimeToolHandler } from './runtime-handler.js';
import { createPublishRequest } from './test-fixtures.js';

describe('runtime MCP handler bridge', () => {
  it('TC-AUTO-DISPATCH-127-01 publish_campaign 只转交结构化请求和结果', async () => {
    const publish = vi.fn().mockResolvedValue({
      campaignId: 'quick-sort-launch',
      receipts: [{ channel: 'github', postId: '123' }],
      failures: [],
    });
    const handler = createRuntimeToolHandler({ publish });

    await expect(handler('publish_campaign', createPublishRequest())).resolves.toMatchObject({
      data: { receipts: [{ channel: 'github', postId: '123' }], failures: [] },
    });
    expect(publish).toHaveBeenCalledWith(createPublishRequest());
  });

  it('TC-AUTO-DISPATCH-127-01 零成功或异常时失败关闭并保留安全错误', async () => {
    const blocked = createRuntimeToolHandler({
      publish: vi.fn().mockResolvedValue({
        campaignId: 'quick-sort-launch',
        receipts: [],
        failures: [{ channel: 'github', code: 'ADAPTER_UNAVAILABLE' }],
      }),
    });
    await expect(blocked('publish_campaign', createPublishRequest())).resolves.toMatchObject({
      isError: true,
    });

    const rejected = createRuntimeToolHandler({
      publish: vi
        .fn()
        .mockRejectedValue(
          new AdapterError('PREFLIGHT_FAILED', 'Preflight failed', { retryable: false }),
        ),
    });
    await expect(rejected('publish_campaign', createPublishRequest())).resolves.toMatchObject({
      isError: true,
      data: { code: 'PREFLIGHT_FAILED', retryable: false },
    });

    const unknown = createRuntimeToolHandler({
      publish: vi.fn().mockRejectedValue(new Error('Bearer private-token')),
    });
    const response = await unknown('publish_campaign', createPublishRequest());
    expect(response).toMatchObject({
      isError: true,
      data: { code: 'ADAPTER_UNAVAILABLE' },
    });
    expect(JSON.stringify(response)).not.toContain('private-token');
  });

  it('TC-AUTO-DISPATCH-127-01 非发布工具继续走默认失败关闭边界', async () => {
    const handler = createRuntimeToolHandler({ publish: vi.fn() });

    await expect(
      handler('channels_status', { projectId: 'algorithm-visualizer' }),
    ).resolves.toMatchObject({
      data: { contractVersion: 3, projectId: 'algorithm-visualizer' },
    });
    await expect(
      handler('list_feedback', {
        projectId: 'algorithm-visualizer',
        postRef: {
          channel: 'github',
          postId: '123',
          publicUrl:
            'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/example',
        },
      }),
    ).resolves.toMatchObject({ isError: true, data: { code: 'ADAPTER_UNAVAILABLE' } });
  });
});
