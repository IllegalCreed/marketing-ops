import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from './contract.js';
import { createMarketingOpsServer } from './server-factory.js';

describe('marketing-ops transport', () => {
  it('TC-AUTO-TRANSPORT-127-01 plugin 只声明本地 STDIO 且不转发 secret env', async () => {
    const config = JSON.parse(
      await readFile(new URL('../.mcp.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(config);

    expect(config).toEqual({
      mcpServers: {
        'marketing-ops': {
          command: 'node',
          args: ['./dist/server.js'],
          cwd: '.',
        },
      },
    });
    expect(serialized).not.toMatch(/bearer|env|http|listen|secret|socket|token|url/i);
  });

  it('TC-AUTO-TRANSPORT-127-02 本地 MCP 可初始化并发现精确七工具', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMarketingOpsServer();
    const client = new Client({ name: 'marketing-ops-test', version: '0.1.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getServerVersion()).toMatchObject({ name: 'marketing-ops', version: '0.1.0' });
      expect(client.getInstructions()?.slice(0, 512)).toMatch(/credentials.*never.*returned/i);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);

      const status = await client.callTool({ name: 'channels_status', arguments: {} });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({ contractVersion: 1 });

      const authorization = {
        source: 'owner-prompt',
        authorizedAt: '2026-07-11T00:00:00.000Z',
      };
      const postRef = {
        channel: 'github',
        postId: 'release-1',
        publicUrl: 'https://github.com/IllegalCreed/algorithms-visualization/releases/tag/v1',
      };
      const publish = await client.callTool({
        name: 'publish_campaign',
        arguments: {
          campaignId: 'quick-sort-launch',
          idempotencyKey: 'campaign-v1/quick-sort-launch/abc12345',
          authorization,
          spec: {
            schemaVersion: 1,
            id: 'quick-sort-launch',
            topic: 'Quick Sort visualization',
            targetUrls: ['https://algo.illegalscreed.cn/docs/quick-sort/'],
            locales: ['en'],
            channels: ['github'],
            publishAt: '2026-07-12T20:00:00+09:00',
            campaign: 'launch-2026q3',
            content: {
              variants: {
                en: {
                  title: 'Quick Sort visualization',
                  angle: 'Trace partitioning step by step.',
                  callToAction: 'Open the visualization',
                },
              },
              media: [],
            },
            replies: { mode: 'off', createBugIssues: true },
            failureMode: 'continue-supported',
          },
        },
      });
      expect(publish).toMatchObject({
        isError: true,
        structuredContent: { code: 'ADAPTER_UNAVAILABLE' },
      });

      await expect(
        client.callTool({
          name: 'get_publish_status',
          arguments: { campaignId: 'quick-sort-launch' },
        }),
      ).resolves.toMatchObject({ structuredContent: { status: 'not-found' } });
      await expect(
        client.callTool({
          name: 'get_campaign_report',
          arguments: { campaignId: 'quick-sort-launch', window: '1h' },
        }),
      ).resolves.toMatchObject({ structuredContent: { status: 'unavailable' } });
      await expect(
        client.callTool({ name: 'list_feedback', arguments: { postRef } }),
      ).resolves.toMatchObject({ isError: true });
      await expect(
        client.callTool({
          name: 'reply_feedback',
          arguments: {
            campaignId: 'quick-sort-launch',
            postRef,
            commentId: 'comment-1',
            body: 'Thanks for the feedback.',
            policy: 'faq-only',
            idempotencyKey: 'campaign-v1/quick-sort-launch/reply123',
            authorization,
          },
        }),
      ).resolves.toMatchObject({ isError: true });
      await expect(
        client.callTool({
          name: 'delete_post',
          arguments: {
            campaignId: 'quick-sort-launch',
            postRef,
            idempotencyKey: 'campaign-v1/quick-sort-launch/delete123',
            authorization,
          },
        }),
      ).resolves.toMatchObject({ isError: true });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
