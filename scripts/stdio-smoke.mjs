import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const expectedTools = [
  'channels_status',
  'publish_campaign',
  'get_publish_status',
  'list_feedback',
  'reply_feedback',
  'delete_post',
  'get_campaign_report',
];

const transport = new StdioClientTransport({
  command: 'node',
  args: ['./dist/server.js'],
  cwd: process.cwd(),
  stderr: 'pipe',
});
const client = new Client({ name: 'marketing-ops-stdio-smoke', version: '0.1.0' });

try {
  await client.connect(transport);
  assert.deepEqual(client.getServerVersion(), { name: 'marketing-ops', version: '0.1.0' });
  assert.match(client.getInstructions()?.slice(0, 512) ?? '', /credentials.*never.*returned/i);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    expectedTools,
  );
  process.stdout.write('marketing-ops stdio smoke: 7 tools verified\n');
} finally {
  await client.close();
}
