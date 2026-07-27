import type { MastodonActivation, MastodonActivationStore } from './mastodon-activation-store.js';
import {
  normalizeMastodonCredentials,
  type MastodonApiHealth,
  type MastodonCredentials,
} from './adapters/mastodon-api.js';
import { MastodonStatusAdapter, type MastodonStatusClient } from './adapters/mastodon-status.js';
import type { MastodonObservabilityClient } from './mastodon-observability.js';
import { MarketingOpsError } from './errors.js';
import type { AdapterRegistration } from './publish-service.js';

export const MASTODON_ACCESS_TOKEN_REF = 'channel/mastodon/access-token';

export interface MastodonSecretStore {
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}

export type MastodonChannelClient = MastodonStatusClient &
  MastodonObservabilityClient & {
    checkHealth(): Promise<MastodonApiHealth>;
  };

export interface PublicMastodonChannelStatus {
  channel: 'mastodon';
  alias: string | null;
  health: 'ready' | 'not-configured' | 'reauth-required' | 'blocked';
  adapterReady: boolean;
  nextAction: string | null;
}

interface MastodonChannelControllerOptions {
  clients: (credentials: MastodonCredentials) => MastodonChannelClient;
  activations: MastodonActivationStore;
  secrets: MastodonSecretStore;
}

interface ResolvedChannel {
  status: PublicMastodonChannelStatus;
  client: MastodonChannelClient | null;
  activation: MastodonActivation | null;
}

function publicStatus(
  alias: string | null,
  health: PublicMastodonChannelStatus['health'],
  adapterReady: boolean,
): PublicMastodonChannelStatus {
  return {
    channel: 'mastodon',
    alias,
    health,
    adapterReady,
    nextAction: adapterReady ? null : 'Run marketing-ops setup mastodon',
  };
}

export class MastodonChannelController {
  readonly #clients: (credentials: MastodonCredentials) => MastodonChannelClient;
  readonly #activations: MastodonActivationStore;
  readonly #secrets: MastodonSecretStore;

  constructor(options: MastodonChannelControllerOptions) {
    this.#clients = options.clients;
    this.#activations = options.activations;
    this.#secrets = options.secrets;
  }

  async getStatus(): Promise<PublicMastodonChannelStatus> {
    return (await this.#resolve()).status;
  }

  async enable(credentialsInput: MastodonCredentials): Promise<PublicMastodonChannelStatus> {
    await this.#activations.get();
    const credentials = normalizeMastodonCredentials(credentialsInput);
    const client = this.#clients(credentials);
    const health = await client.checkHealth();
    if (health.health !== 'ready' || !health.alias || !health.accountId) {
      if (health.health === 'reauth-required') {
        throw new MarketingOpsError('REAUTH_REQUIRED', 'Mastodon authorization must be renewed');
      }
      throw new MarketingOpsError('ADAPTER_UNAVAILABLE', 'Mastodon account health is not ready');
    }
    if (health.instanceUrl !== credentials.instanceUrl) {
      throw new MarketingOpsError(
        'ADAPTER_UNAVAILABLE',
        'Mastodon instance identity did not match',
      );
    }
    await this.#activations.enable({
      instanceUrl: health.instanceUrl,
      alias: health.alias,
      accountId: health.accountId,
    });
    await this.#secrets.put(MASTODON_ACCESS_TOKEN_REF, credentials.accessToken);
    return publicStatus(health.alias, 'ready', true);
  }

  async createRegistration(): Promise<AdapterRegistration | null> {
    const resolved = await this.#resolve();
    if (!resolved.client || !resolved.activation || !resolved.status.adapterReady) return null;
    return {
      adapter: new MastodonStatusAdapter({
        client: resolved.client,
        accountId: resolved.activation.accountId,
      }),
      enabled: true,
      health: 'ready',
    };
  }

  async createEnabledClient(): Promise<MastodonObservabilityClient | null> {
    const resolved = await this.#resolve();
    return resolved.status.adapterReady ? resolved.client : null;
  }

  async #resolve(): Promise<ResolvedChannel> {
    let activation: MastodonActivation | null;
    try {
      activation = await this.#activations.get();
    } catch {
      return { status: publicStatus(null, 'blocked', false), client: null, activation: null };
    }
    if (!activation) {
      return { status: publicStatus(null, 'not-configured', false), client: null, activation };
    }

    let credentials: MastodonCredentials;
    try {
      credentials = normalizeMastodonCredentials({
        instanceUrl: activation.instanceUrl,
        accessToken: await this.#secrets.get(MASTODON_ACCESS_TOKEN_REF),
      });
    } catch {
      return {
        status: publicStatus(activation.alias, 'reauth-required', false),
        client: null,
        activation,
      };
    }

    const client = this.#clients(credentials);
    let health: MastodonApiHealth;
    try {
      health = await client.checkHealth();
    } catch {
      return { status: publicStatus(activation.alias, 'blocked', false), client: null, activation };
    }
    if (
      health.health !== 'ready' ||
      health.instanceUrl !== activation.instanceUrl ||
      health.alias !== activation.alias ||
      health.accountId !== activation.accountId
    ) {
      return {
        status: publicStatus(
          activation.alias,
          health.health === 'reauth-required' ? 'reauth-required' : 'blocked',
          false,
        ),
        client: null,
        activation,
      };
    }
    return { status: publicStatus(activation.alias, 'ready', true), client, activation };
  }
}
