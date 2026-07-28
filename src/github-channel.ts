import type { GitHubActivationStore } from './activation-store.js';
import type { GitHubCliClient, GitHubCliHealth } from './adapters/github-cli.js';
import type { GitHubIssueClient } from './adapters/github-issue.js';
import type { GitHubIssueReplyClient } from './adapters/github-issue-reply.js';
import { GitHubReleaseAdapter, type GitHubReleaseClient } from './adapters/github-release.js';
import { MarketingOpsError } from './errors.js';
import type { GitHubObservabilityClient } from './github-observability.js';
import type { AdapterRegistration } from './publish-service.js';

export interface PublicGitHubChannelStatus {
  channel: 'github';
  alias: string | null;
  health: 'ready' | 'not-configured' | 'reauth-required' | 'blocked';
  adapterReady: boolean;
  nextAction: string | null;
}

type GitHubChannelClient = GitHubReleaseClient &
  GitHubObservabilityClient &
  GitHubIssueClient &
  GitHubIssueReplyClient &
  Pick<GitHubCliClient, 'checkHealth'>;

interface GitHubChannelControllerOptions {
  client: GitHubChannelClient;
  activations: GitHubActivationStore;
  repository: string;
}

function publicStatus(health: GitHubCliHealth, adapterReady: boolean): PublicGitHubChannelStatus {
  return {
    channel: 'github',
    alias: health.alias,
    health: health.health,
    adapterReady,
    nextAction: adapterReady ? null : 'Run marketing-ops setup github',
  };
}

export class GitHubChannelController {
  readonly #client: GitHubChannelClient;
  readonly #activations: GitHubActivationStore;
  readonly #repository: string;

  constructor(options: GitHubChannelControllerOptions) {
    this.#client = options.client;
    this.#activations = options.activations;
    this.#repository = options.repository;
  }

  async getStatus(): Promise<PublicGitHubChannelStatus> {
    const health = await this.#client.checkHealth(this.#repository);
    try {
      const activation = await this.#activations.get();
      return publicStatus(health, activation !== null && health.health === 'ready');
    } catch {
      return {
        channel: 'github',
        alias: health.alias,
        health: 'blocked',
        adapterReady: false,
        nextAction: 'Run marketing-ops setup github',
      };
    }
  }

  async enable(): Promise<PublicGitHubChannelStatus> {
    const health = await this.#client.checkHealth(this.#repository);
    if (health.health !== 'ready') {
      if (health.health === 'reauth-required') {
        throw new MarketingOpsError('REAUTH_REQUIRED', 'GitHub authorization must be renewed');
      }
      throw new MarketingOpsError(
        'ADAPTER_UNAVAILABLE',
        'GitHub CLI and repository write access must be ready',
      );
    }
    await this.#activations.enable();
    return publicStatus(health, true);
  }

  async createRegistration(): Promise<AdapterRegistration | null> {
    if (!(await this.#isEnabledAndHealthy())) return null;
    return {
      adapter: new GitHubReleaseAdapter({ client: this.#client, repository: this.#repository }),
      enabled: true,
      health: 'ready',
    };
  }

  async createEnabledClient(): Promise<GitHubObservabilityClient | null> {
    return (await this.#isEnabledAndHealthy()) ? this.#client : null;
  }

  async createEnabledIssueClient(): Promise<(GitHubIssueClient & GitHubIssueReplyClient) | null> {
    return (await this.#isEnabledAndHealthy()) ? this.#client : null;
  }

  async #isEnabledAndHealthy(): Promise<boolean> {
    try {
      if (!(await this.#activations.get())) return false;
    } catch {
      return false;
    }
    const health = await this.#client.checkHealth(this.#repository);
    return health.health === 'ready';
  }
}
