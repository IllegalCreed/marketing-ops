import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import {
  assertSafeToolInput,
  CONTRACT_VERSION,
  sanitizeToolOutput,
  SERVER_INSTRUCTIONS,
  TOOL_DEFINITIONS,
  TOOL_INPUT_SCHEMAS,
  type ToolName,
} from './contract.js';

interface ToolResponse {
  data: unknown;
  isError?: boolean;
}

export type MarketingToolHandler = (
  name: ToolName,
  input: Record<string, unknown>,
) => Promise<ToolResponse>;

export function defaultChannelStatuses() {
  return ['github', 'weibo', 'bluesky', 'dev', 'mastodon'].map((channel) => ({
    channel,
    alias: null,
    health: 'not-configured',
    adapterReady: false,
    nextAction: `Run marketing-ops setup ${channel}`,
  }));
}

export const failClosedToolHandler: MarketingToolHandler = async (name, input) => {
  assertSafeToolInput(input);
  const schema = TOOL_INPUT_SCHEMAS[name] as z.ZodType<Record<string, unknown>>;
  const parsed = schema.parse(input);

  if (name === 'channels_status') {
    return { data: { contractVersion: CONTRACT_VERSION, channels: defaultChannelStatuses() } };
  }
  if (name === 'get_publish_status') {
    return {
      data: { campaignId: parsed.campaignId, status: 'not-found', receipts: [], failures: [] },
    };
  }
  if (name === 'get_campaign_report') {
    return {
      data: {
        campaignId: parsed.campaignId,
        window: parsed.window,
        status: 'unavailable',
        reason: 'No collectors are enabled in T3-A',
      },
    };
  }
  return {
    isError: true,
    data: {
      code: 'ADAPTER_UNAVAILABLE',
      message: 'No enabled platform adapter is configured',
    },
  };
};

function asToolResult(response: ToolResponse): CallToolResult {
  const sanitized = sanitizeToolOutput(response.data);
  const structuredContent =
    typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
      ? (sanitized as Record<string, unknown>)
      : { value: sanitized };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(response.isError ? { isError: true } : {}),
  };
}

export function createMarketingOpsServer(
  handler: MarketingToolHandler = failClosedToolHandler,
): McpServer {
  const server = new McpServer(
    { name: 'marketing-ops', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const definition of TOOL_DEFINITIONS) {
    const inputSchema = TOOL_INPUT_SCHEMAS[definition.name] as z.ZodType<Record<string, unknown>>;
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema,
        annotations: definition.annotations as ToolAnnotations,
      },
      async (input) => asToolResult(await handler(definition.name, input)),
    );
  }

  return server;
}
