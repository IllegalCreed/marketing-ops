export const TEST_CONTENT_HASH = 'a'.repeat(64);

export function createGitHubPackage(media: Array<'image' | 'gif' | 'video'> = []) {
  return {
    channel: 'github' as const,
    format: 'release' as const,
    utmMedium: 'community' as const,
    variants: [
      {
        locale: 'zh-CN' as const,
        title: '快速排序可视化已上线',
        body: '逐步观察分区过程。\n\n[打开可视化](https://algo.illegalscreed.cn/docs/quick-sort/?utm_source=github)',
        links: ['https://algo.illegalscreed.cn/docs/quick-sort/?utm_source=github'],
        media,
      },
      {
        locale: 'en' as const,
        title: 'Quick Sort visualization is live',
        body: 'Trace partitioning step by step.\n\n[Open it](https://algo.illegalscreed.cn/en/docs/quick-sort/?utm_source=github)',
        links: ['https://algo.illegalscreed.cn/en/docs/quick-sort/?utm_source=github'],
        media,
      },
    ],
  };
}

export function createPublishRequest() {
  return {
    campaignId: 'quick-sort-launch',
    idempotencyKey: 'campaign-v2/quick-sort-launch/abc12345',
    authorization: {
      source: 'owner-prompt' as const,
      authorizedAt: '2026-07-11T00:00:00.000Z',
    },
    spec: {
      schemaVersion: 1 as const,
      id: 'quick-sort-launch',
      topic: 'Quick Sort visualization',
      targetUrls: ['https://algo.illegalscreed.cn/docs/quick-sort/'],
      locales: ['zh-CN', 'en'] as const,
      channels: ['github'] as const,
      publishAt: '2026-07-12T20:00:00+09:00',
      campaign: 'launch-2026q3',
      content: {
        variants: {
          'zh-CN': {
            title: '快速排序可视化已上线',
            angle: '逐步观察分区过程。',
            callToAction: '打开可视化',
          },
          en: {
            title: 'Quick Sort visualization is live',
            angle: 'Trace partitioning step by step.',
            callToAction: 'Open the visualization',
          },
        },
        media: [] as const,
      },
      replies: { mode: 'off' as const, createBugIssues: true },
      failureMode: 'continue-supported' as const,
    },
    packages: [createGitHubPackage()],
  };
}

export function createAdapterPublishInput() {
  const request = createPublishRequest();
  return {
    campaignId: request.campaignId,
    idempotencyKey: `${request.idempotencyKey}/github`,
    contentHash: TEST_CONTENT_HASH,
    package: createGitHubPackage(),
  };
}
