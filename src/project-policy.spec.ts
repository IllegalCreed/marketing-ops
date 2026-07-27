import { describe, expect, it } from 'vitest';
import { TOOL_INPUT_SCHEMAS } from './contract.js';
import { assertProjectPublishRequest } from './project-policy.js';
import type { ProjectProfile } from './project-profile-store.js';
import { createPublishRequest } from './test-fixtures.js';

const profile: ProjectProfile = {
  schemaVersion: 1,
  id: 'algorithm-visualizer',
  displayName: 'Algorithm Visualizer',
  canonicalOrigins: ['https://algo.illegalscreed.cn'],
  channels: ['github', 'dev'],
  github: { repository: 'IllegalCreed/algorithms-visualization' },
  dev: { tags: ['algorithms', 'webdev', 'opensource'] },
};

describe('project publish policy', () => {
  it('TC-AUTO-TARGET-133-01 只允许 profile 渠道与 origin 内的 target/package/canonical', () => {
    const request = TOOL_INPUT_SCHEMAS.publish_campaign.parse(createPublishRequest());
    const firstPackage = request.packages[0]!;
    const firstVariant = firstPackage.variants[0]!;

    expect(() => assertProjectPublishRequest(profile, request)).not.toThrow();
    expect(() =>
      assertProjectPublishRequest(profile, { ...request, projectId: 'other-project' }),
    ).toThrow(/does not match/i);
    expect(() =>
      assertProjectPublishRequest(profile, {
        ...request,
        spec: { ...request.spec, targetUrls: ['http://algo.illegalscreed.cn/path'] },
      }),
    ).toThrow(/project origin/i);
    expect(() =>
      assertProjectPublishRequest(profile, {
        ...request,
        spec: {
          ...request.spec,
          targetUrls: ['https://user@algo.illegalscreed.cn/path'],
        },
      }),
    ).toThrow(/project origin/i);
    expect(() =>
      assertProjectPublishRequest(profile, {
        ...request,
        spec: { ...request.spec, targetUrls: ['https://attacker.example/path'] },
      }),
    ).toThrow(/project origin/i);
    expect(() =>
      assertProjectPublishRequest(profile, {
        ...request,
        packages: [
          {
            ...firstPackage,
            variants: [
              {
                ...firstVariant,
                links: ['https://algo.illegalscreed.cn.attacker.example/path'],
              },
            ],
          },
        ],
      }),
    ).toThrow(/project origin/i);
    expect(() =>
      assertProjectPublishRequest(profile, {
        ...request,
        packages: [{ ...firstPackage, canonicalUrl: 'https://attacker.example/path' }],
      }),
    ).toThrow(/project origin/i);
    expect(() =>
      assertProjectPublishRequest(
        {
          schemaVersion: 1,
          id: 'algorithm-visualizer',
          displayName: 'Algorithm Visualizer',
          canonicalOrigins: ['https://algo.illegalscreed.cn'],
          channels: ['dev'],
          dev: { tags: ['algorithms'] },
        },
        request,
      ),
    ).toThrow(/not enabled/i);
    expect(() =>
      assertProjectPublishRequest(
        {
          schemaVersion: 1,
          id: 'algorithm-visualizer',
          displayName: 'Algorithm Visualizer',
          canonicalOrigins: ['https://algo.illegalscreed.cn'],
          channels: ['dev'],
          dev: { tags: ['algorithms'] },
        },
        {
          ...request,
          spec: { ...request.spec, channels: 'all-authorized' },
        },
      ),
    ).toThrow(/not enabled/i);
  });
});
