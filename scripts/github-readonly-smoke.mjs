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
const tagReference = await client.findTagReference(repository, probeTag);
if (tagReference) assert.equal(tagReference.ref, `refs/tags/${probeTag}`);
const [views, clones, referrers, paths, issues] = await Promise.all([
  client.getTrafficViews(repository),
  client.getTrafficClones(repository),
  client.getTrafficReferrers(repository),
  client.getTrafficPaths(repository),
  client.listIssues(repository, 1),
]);
assert.ok(views.count >= 0 && views.uniques >= 0 && views.points.length <= 14);
assert.ok(clones.count >= 0 && clones.uniques >= 0 && clones.points.length <= 14);
assert.ok(referrers.length <= 10);
assert.ok(paths.length <= 10);
assert.ok(issues.length <= 100);

let commentsChecked = false;
if (issues[0]) {
  const comments = await client.listIssueComments(repository, issues[0].number, 1);
  assert.ok(comments.length <= 100);
  commentsChecked = true;
}

process.stdout.write(
  `github read-only smoke: ${health.alias}, ${repository}, releaseFound=${String(Boolean(release))}, tagRefFound=${String(Boolean(tagReference))}, traffic=ready, issues=ready, commentsChecked=${String(commentsChecked)}\n`,
);
