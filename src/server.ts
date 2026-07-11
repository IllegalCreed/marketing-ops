import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMarketingOpsServer } from './server-factory.js';

const server = createMarketingOpsServer();
const transport = new StdioServerTransport();

try {
  await server.connect(transport);
} catch {
  process.stderr.write('marketing-ops failed to start\n');
  process.exitCode = 1;
}
