import type { DevActivation, DevActivationStore } from './dev-activation-store.js';
import { normalizeDevApiKey, type DevApiHealth } from './adapters/dev-api.js';
import {
  DevArticleAdapter,
  type DevArticleClient,
  type DevArticleProjectPolicy,
} from './adapters/dev-article.js';
import type { DevObservabilityClient } from './dev-observability.js';
import { MarketingOpsError } from './errors.js';
import type { AdapterRegistration } from './publish-service.js';

export const DEV_API_KEY_REF = 'channel/dev/api-key';

export interface DevSecretStore {
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}

export type DevChannelClient = DevArticleClient &
  DevObservabilityClient & {
    checkHealth(): Promise<DevApiHealth>;
  };

export interface PublicDevChannelStatus {
  channel: 'dev';
  alias: string | null;
  health: 'ready' | 'not-configured' | 'reauth-required' | 'blocked';
  adapterReady: boolean;
  nextAction: string | null;
}

interface DevChannelControllerOptions {
  clients: (apiKey: string) => DevChannelClient;
  activations: DevActivationStore;
  secrets: DevSecretStore;
}

interface ResolvedChannel {
  status: PublicDevChannelStatus;
  client: DevChannelClient | null;
}

function publicStatus(
  alias: string | null,
  health: PublicDevChannelStatus['health'],
  adapterReady: boolean,
): PublicDevChannelStatus {
  return {
    channel: 'dev',
    alias,
    health,
    adapterReady,
    nextAction: adapterReady ? null : 'Run marketing-ops setup dev',
  };
}

export class DevChannelController {
  readonly #clients: (apiKey: string) => DevChannelClient;
  readonly #activations: DevActivationStore;
  readonly #secrets: DevSecretStore;

  constructor(options: DevChannelControllerOptions) {
    this.#clients = options.clients;
    this.#activations = options.activations;
    this.#secrets = options.secrets;
  }

  async getStatus(): Promise<PublicDevChannelStatus> {
    return (await this.#resolve()).status;
  }

  async enable(apiKeyInput: string): Promise<PublicDevChannelStatus> {
    await this.#activations.get();
    const apiKey = normalizeDevApiKey(apiKeyInput);
    const health = await this.#clients(apiKey).checkHealth();
    if (health.health !== 'ready' || !health.alias || !health.userId) {
      if (health.health === 'reauth-required') {
        throw new MarketingOpsError('REAUTH_REQUIRED', 'DEV authorization must be renewed');
      }
      throw new MarketingOpsError('ADAPTER_UNAVAILABLE', 'DEV account health is not ready');
    }
    await this.#secrets.put(DEV_API_KEY_REF, apiKey);
    await this.#activations.enable({ username: health.alias, userId: health.userId });
    return publicStatus(health.alias, 'ready', true);
  }

  async createRegistration(project: DevArticleProjectPolicy): Promise<AdapterRegistration | null> {
    const resolved = await this.#resolve();
    if (!resolved.client || !resolved.status.adapterReady) return null;
    return {
      adapter: new DevArticleAdapter({ client: resolved.client, ...project }),
      enabled: true,
      health: 'ready',
    };
  }

  async createEnabledClient(): Promise<DevObservabilityClient | null> {
    const resolved = await this.#resolve();
    return resolved.status.adapterReady ? resolved.client : null;
  }

  async #resolve(): Promise<ResolvedChannel> {
    let activation: DevActivation | null;
    try {
      activation = await this.#activations.get();
    } catch {
      return { status: publicStatus(null, 'blocked', false), client: null };
    }
    if (!activation) {
      return { status: publicStatus(null, 'not-configured', false), client: null };
    }

    let apiKey: string;
    try {
      apiKey = normalizeDevApiKey(await this.#secrets.get(DEV_API_KEY_REF));
    } catch {
      return { status: publicStatus(activation.username, 'reauth-required', false), client: null };
    }
    const client = this.#clients(apiKey);
    let health: DevApiHealth;
    try {
      health = await client.checkHealth();
    } catch {
      return { status: publicStatus(activation.username, 'blocked', false), client: null };
    }
    if (
      health.health !== 'ready' ||
      health.alias !== activation.username ||
      health.userId !== activation.userId
    ) {
      return {
        status: publicStatus(
          activation.username,
          health.health === 'reauth-required' ? 'reauth-required' : 'blocked',
          false,
        ),
        client: null,
      };
    }
    return { status: publicStatus(activation.username, 'ready', true), client };
  }
}
