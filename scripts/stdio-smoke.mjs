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
  const tools = (await client.listTools()).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    expectedTools,
  );
  for (const tool of tools) {
    assert.ok(tool.inputSchema.required?.includes('projectId'));
  }
  const status = await client.callTool({
    name: 'channels_status',
    arguments: { projectId: 'algorithm-visualizer' },
  });
  if (status.isError) {
    assert.equal(status.structuredContent?.code, 'INVALID_INPUT');
  } else {
    assert.equal(status.structuredContent?.contractVersion, 3);
    assert.equal(status.structuredContent?.projectId, 'algorithm-visualizer');
    const github = status.structuredContent?.channels?.find(
      (channel) => channel.channel === 'github',
    );
    assert.ok(github);
    assert.match(github.health, /^(ready|not-configured|reauth-required|blocked)$/);
    assert.equal(typeof github.adapterReady, 'boolean');
  }
  assert.doesNotMatch(JSON.stringify(status), /token|cookie|profile.?path|\/Users\//i);
  process.stdout.write(
    'marketing-ops stdio smoke: contract v3, 7 project-scoped tools, and sanitized status verified\n',
  );
} finally {
  await client.close();
}
