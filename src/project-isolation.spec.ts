import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_PROJECT_ID,
  ReceiptStore,
  receiptProjectId,
  type PublishReceipt,
} from './receipt-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'marketing-ops-isolation-'));
  roots.push(value);
  return value;
}

function receipt(projectId: string, idempotencyKey: string, postId: string): PublishReceipt {
  return {
    schemaVersion: 2,
    projectId,
    campaignId: 'shared-campaign',
    channel: 'mastodon',
    postId,
    publicUrl: `https://mastodon.social/@owner/${postId}`,
    publishedAt: '2026-07-27T00:00:00.000Z',
    contentHash: 'a'.repeat(64),
    idempotencyKey,
    adapterVersion: 'mastodon-status@0.1.0',
    status: 'published',
  };
}

describe('project receipt isolation and migration', () => {
  it('TC-AUTO-ISOLATION-133-01..02 同 campaign 可分项目存储且跨项目查询/删除失败关闭', async () => {
    const store = new ReceiptStore(await root());
    const first = receipt('project-a', 'campaign-v3/project-a/shared/mastodon/aaa', '1');
    const second = receipt('project-b', 'campaign-v3/project-b/shared/mastodon/bbb', '2');
    await store.save(first);
    await store.save(second);

    await expect(store.listByCampaign('project-a', 'shared-campaign')).resolves.toEqual([first]);
    await expect(store.listByCampaign('project-b', 'shared-campaign')).resolves.toEqual([second]);
    await expect(
      store.findKnownPostRef('project-b', {
        channel: first.channel,
        postId: first.postId,
        publicUrl: first.publicUrl,
      }),
    ).resolves.toBeNull();
    await expect(store.markDeleted('project-b', first.idempotencyKey)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('TC-AUTO-MIGRATION-133-01 v1 receipt 只显式归属 Algorithm Visualizer', async () => {
    const store = new ReceiptStore(await root());
    const legacy: PublishReceipt = {
      schemaVersion: 1,
      campaignId: 'quick-sort-launch',
      channel: 'dev',
      postId: '4146005',
      publicUrl: 'https://dev.to/illegalcreed/quick-sort-visualization',
      publishedAt: '2026-07-15T00:00:00.000Z',
      contentHash: 'b'.repeat(64),
      idempotencyKey: 'campaign-v2/quick-sort-launch/dev/legacy',
      adapterVersion: 'dev-article@0.1.0',
      status: 'published',
    };
    await store.save(legacy);

    expect(receiptProjectId(legacy)).toBe(LEGACY_PROJECT_ID);
    await expect(store.listByCampaign(LEGACY_PROJECT_ID, legacy.campaignId)).resolves.toEqual([
      legacy,
    ]);
    await expect(store.listByCampaign('other-project', legacy.campaignId)).resolves.toEqual([]);
  });
});
