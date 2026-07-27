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

export function createBlueskyPackage(media: Array<'image' | 'gif' | 'video'> = []) {
  const url =
    'https://algo.illegalscreed.cn/en/docs/quick-sort/?utm_source=bluesky&utm_medium=social&utm_campaign=launch';
  return {
    channel: 'bluesky' as const,
    format: 'post' as const,
    utmMedium: 'social' as const,
    variants: [
      {
        locale: 'en' as const,
        title: 'Quick Sort visualization is live',
        body: `Quick Sort visualization is live\n\nTrace partitioning step by step.\n\nOpen the visualization: ${url}`,
        links: [url],
        media,
      },
    ],
  };
}

export function createDevPackage(media: Array<'image' | 'gif' | 'video'> = []) {
  const canonicalUrl = 'https://algo.illegalscreed.cn/en/docs/quick-sort/';
  const url = `${canonicalUrl}?utm_source=dev&utm_medium=community&utm_campaign=launch&utm_content=dev-en-link-1`;
  return {
    channel: 'dev' as const,
    format: 'article' as const,
    utmMedium: 'community' as const,
    canonicalUrl,
    variants: [
      {
        locale: 'en' as const,
        title: 'Quick Sort visualization is live',
        body: `Trace partitioning step by step.\n\n[Open it](${url})`,
        links: [url],
        media,
      },
    ],
  };
}

export function createMastodonPackage(media: Array<'image' | 'gif' | 'video'> = []) {
  const canonicalUrl = 'https://algo.illegalscreed.cn/en/docs/quick-sort/';
  const url = `${canonicalUrl}?utm_source=mastodon&utm_medium=social&utm_campaign=launch&utm_content=mastodon-en-link-1`;
  return {
    channel: 'mastodon' as const,
    format: 'status' as const,
    utmMedium: 'social' as const,
    canonicalUrl,
    variants: [
      {
        locale: 'en' as const,
        title: 'Quick Sort visualization is live',
        body: `Quick Sort visualization is live\n\nTrace partitioning step by step.\n\nOpen the visualization: ${url}`,
        links: [url],
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

export function createBlueskyPublishRequest() {
  const request = createPublishRequest();
  return {
    ...request,
    spec: {
      ...request.spec,
      locales: ['en'] as const,
      channels: ['bluesky'] as const,
    },
    packages: [createBlueskyPackage()],
  };
}

export function createDevPublishRequest() {
  const request = createPublishRequest();
  return {
    ...request,
    spec: {
      ...request.spec,
      targetUrls: ['https://algo.illegalscreed.cn/en/docs/quick-sort/'],
      locales: ['en'] as const,
      channels: ['dev'] as const,
    },
    packages: [createDevPackage()],
  };
}

export function createMastodonPublishRequest() {
  const request = createPublishRequest();
  return {
    ...request,
    spec: {
      ...request.spec,
      targetUrls: ['https://algo.illegalscreed.cn/en/docs/quick-sort/'],
      locales: ['en'] as const,
      channels: ['mastodon'] as const,
    },
    packages: [createMastodonPackage()],
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
