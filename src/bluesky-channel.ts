import type { BlueskyActivation, BlueskyActivationStore } from './bluesky-activation-store.js';
import {
  normalizeBlueskyCredentials,
  type BlueskyApiHealth,
  type BlueskyCredentials,
} from './adapters/bluesky-api.js';
import { BlueskyTextAdapter, type BlueskyTextClient } from './adapters/bluesky-post.js';
import { MarketingOpsError } from './errors.js';
import type { AdapterRegistration } from './publish-service.js';

export const BLUESKY_HANDLE_REF = 'channel/bluesky/alias';
export const BLUESKY_APP_PASSWORD_REF = 'channel/bluesky/app-password';

export interface BlueskySecretStore {
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}

export type BlueskyChannelClient = BlueskyTextClient & {
  checkHealth(): Promise<BlueskyApiHealth>;
};

export interface PublicBlueskyChannelStatus {
  channel: 'bluesky';
  alias: string | null;
  health: 'ready' | 'not-configured' | 'reauth-required' | 'blocked';
  adapterReady: boolean;
  nextAction: string | null;
}

interface BlueskyChannelControllerOptions {
  clients: (credentials: BlueskyCredentials) => BlueskyChannelClient;
  activations: BlueskyActivationStore;
  secrets: BlueskySecretStore;
}

interface ResolvedChannel {
  status: PublicBlueskyChannelStatus;
  client: BlueskyChannelClient | null;
}

function publicStatus(
  alias: string | null,
  health: PublicBlueskyChannelStatus['health'],
  adapterReady: boolean,
): PublicBlueskyChannelStatus {
  return {
    channel: 'bluesky',
    alias,
    health,
    adapterReady,
    nextAction: adapterReady ? null : 'Run marketing-ops setup bluesky',
  };
}

export class BlueskyChannelController {
  readonly #clients: (credentials: BlueskyCredentials) => BlueskyChannelClient;
  readonly #activations: BlueskyActivationStore;
  readonly #secrets: BlueskySecretStore;

  constructor(options: BlueskyChannelControllerOptions) {
    this.#clients = options.clients;
    this.#activations = options.activations;
    this.#secrets = options.secrets;
  }

  async getStatus(): Promise<PublicBlueskyChannelStatus> {
    return (await this.#resolve()).status;
  }

  async enable(credentialsInput: BlueskyCredentials): Promise<PublicBlueskyChannelStatus> {
    await this.#activations.get();
    const credentials = normalizeBlueskyCredentials(credentialsInput);
    const client = this.#clients(credentials);
    const health = await client.checkHealth();
    if (health.health !== 'ready' || !health.alias || !health.did) {
      if (health.health === 'reauth-required') {
        throw new MarketingOpsError('REAUTH_REQUIRED', 'Bluesky authorization must be renewed');
      }
      throw new MarketingOpsError('ADAPTER_UNAVAILABLE', 'Bluesky account health is not ready');
    }
    if (health.alias !== credentials.handle) {
      throw new MarketingOpsError('ADAPTER_UNAVAILABLE', 'Bluesky account identity did not match');
    }
    await this.#secrets.put(BLUESKY_APP_PASSWORD_REF, credentials.appPassword);
    await this.#secrets.put(BLUESKY_HANDLE_REF, credentials.handle);
    await this.#activations.enable({ handle: health.alias, did: health.did });
    return publicStatus(health.alias, 'ready', true);
  }

  async createRegistration(): Promise<AdapterRegistration | null> {
    const resolved = await this.#resolve();
    if (!resolved.client || !resolved.status.adapterReady) return null;
    return {
      adapter: new BlueskyTextAdapter({ client: resolved.client }),
      enabled: true,
      health: 'ready',
    };
  }

  async #resolve(): Promise<ResolvedChannel> {
    let activation: BlueskyActivation | null;
    try {
      activation = await this.#activations.get();
    } catch {
      return { status: publicStatus(null, 'blocked', false), client: null };
    }
    if (!activation) {
      return { status: publicStatus(null, 'not-configured', false), client: null };
    }

    let credentials: BlueskyCredentials;
    try {
      credentials = normalizeBlueskyCredentials({
        handle: await this.#secrets.get(BLUESKY_HANDLE_REF),
        appPassword: await this.#secrets.get(BLUESKY_APP_PASSWORD_REF),
      });
    } catch {
      return {
        status: publicStatus(activation.handle, 'reauth-required', false),
        client: null,
      };
    }
    if (credentials.handle !== activation.handle) {
      return { status: publicStatus(activation.handle, 'blocked', false), client: null };
    }

    const client = this.#clients(credentials);
    let health: BlueskyApiHealth;
    try {
      health = await client.checkHealth();
    } catch {
      return { status: publicStatus(activation.handle, 'blocked', false), client: null };
    }
    if (
      health.health !== 'ready' ||
      health.alias !== activation.handle ||
      health.did !== activation.did
    ) {
      return {
        status: publicStatus(
          activation.handle,
          health.health === 'reauth-required' ? 'reauth-required' : 'blocked',
          false,
        ),
        client: null,
      };
    }
    return { status: publicStatus(activation.handle, 'ready', true), client };
  }
}
