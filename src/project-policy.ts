import type { PublishCampaignInput } from './contract.js';
import { MarketingOpsError } from './errors.js';
import type { ProjectProfile } from './project-profile-store.js';

function assertAllowedUrl(profile: ProjectProfile, value: string): void {
  let origin: string;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe');
    origin = url.origin;
  } catch {
    throw new MarketingOpsError('INVALID_INPUT', 'Campaign URL is outside the project origin');
  }
  if (!profile.canonicalOrigins.includes(origin)) {
    throw new MarketingOpsError('INVALID_INPUT', 'Campaign URL is outside the project origin');
  }
}

export function assertProjectPublishRequest(
  profile: ProjectProfile,
  request: PublishCampaignInput,
): void {
  if (request.projectId !== profile.id) {
    throw new MarketingOpsError('INVALID_INPUT', 'Campaign project does not match the profile');
  }
  const allowedChannels = new Set(profile.channels);
  const requestedChannels = request.spec.channels === 'all-authorized' ? [] : request.spec.channels;
  if (
    requestedChannels.some((channel) => !allowedChannels.has(channel)) ||
    request.packages.some((packageValue) => !allowedChannels.has(packageValue.channel))
  ) {
    throw new MarketingOpsError('INVALID_INPUT', 'Campaign channel is not enabled for the project');
  }
  for (const targetUrl of request.spec.targetUrls) assertAllowedUrl(profile, targetUrl);
  for (const packageValue of request.packages) {
    if (packageValue.canonicalUrl) assertAllowedUrl(profile, packageValue.canonicalUrl);
    for (const variant of packageValue.variants) {
      for (const link of variant.links) assertAllowedUrl(profile, link);
    }
  }
}
