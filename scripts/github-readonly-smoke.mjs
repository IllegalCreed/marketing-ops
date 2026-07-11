import assert from 'node:assert/strict';
import { GitHubCliClient } from '../dist/adapters/github-cli.js';

const repository = 'IllegalCreed/algorithms-visualization';
const probeTag = 'marketing/marketing-ops-read-only-probe-127';
const client = new GitHubCliClient();
const health = await client.checkHealth(repository);

assert.equal(health.health, 'ready');
assert.ok(health.alias);
const release = await client.findReleaseByTag(repository, probeTag);
if (release) assert.equal(release.tagName, probeTag);

process.stdout.write(
  `github read-only smoke: ${health.alias}, ${repository}, tagFound=${String(Boolean(release))}\n`,
);
