import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MastodonActivationStore } from './mastodon-activation-store.js';
import {
  MASTODON_ACCESS_TOKEN_REF,
  MastodonChannelController,
  type MastodonChannelClient,
  type MastodonSecretStore,
} from './mastodon-channel.js';

const INSTANCE_URL = 'https://mastodon.social';
const ACCESS_TOKEN = 'mastodon-access-token-abcdefghijklmnop';
const ACCOUNT_ID = '109876';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'marketing-ops-mastodon-channel-'));
  roots.push(value);
  return value;
}

function secrets(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const store: MastodonSecretStore = {
    put: vi.fn(async (ref, value) => {
      values.set(ref, value);
    }),
    get: vi.fn(async (ref) => {
      const value = values.get(ref);
      if (!value) throw new Error('Keychain unavailable');
      return value;
    }),
    delete: vi.fn(async (ref) => {
      values.delete(ref);
    }),
  };
  return { values, store };
}

function client(
  health: 'ready' | 'reauth-required' | 'blocked' = 'ready',
  alias = 'illegalcreed@mastodon.social',
  accountId = ACCOUNT_ID,
): MastodonChannelClient {
  return {
    checkHealth: vi.fn(async () => ({
      health,
      instanceUrl: INSTANCE_URL,
      alias: health === 'ready' ? alias : null,
      accountId: health === 'ready' ? accountId : null,
      reason:
        health === 'ready'
          ? ('READY' as const)
          : health === 'reauth-required'
            ? ('REAUTH_REQUIRED' as const)
            : ('UNAVAILABLE' as const),
    })),
    findRecentStatusByText: vi.fn(async () => ({ complete: true, status: null })),
    createStatus: vi.fn(),
    deleteStatus: vi.fn(),
    getStatus: vi.fn(),
    listNotifications: vi.fn(),
  };
}

function options(directory: string, secretStore: MastodonSecretStore, value = client()) {
  return {
    clients: vi.fn(() => value),
    activations: new MastodonActivationStore(directory),
    secrets: secretStore,
  };
}

describe('Mastodon channel controller', () => {
  it('TC-AUTO-MASTODONCHANNEL-127-01 无 activation 时不读取 Keychain 或构造 client', async () => {
    const keychain = secrets();
    const controllerOptions = options(await root(), keychain.store);
    const controller = new MastodonChannelController(controllerOptions);

    await expect(controller.getStatus()).resolves.toEqual({
      channel: 'mastodon',
      alias: null,
      health: 'not-configured',
      adapterReady: false,
      nextAction: 'Run marketing-ops setup mastodon',
    });
    await expect(controller.createRegistration()).resolves.toBeNull();
    expect(keychain.store.get).not.toHaveBeenCalled();
    expect(controllerOptions.clients).not.toHaveBeenCalled();
  });

  it('TC-AUTO-MASTODONCHANNEL-127-02 setup 先验证身份，再保存 Keychain 与 activation', async () => {
    const directory = await root();
    const keychain = secrets();
    const controllerOptions = options(directory, keychain.store);
    const controller = new MastodonChannelController(controllerOptions);

    await expect(
      controller.enable({ instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN }),
    ).resolves.toEqual({
      channel: 'mastodon',
      alias: 'illegalcreed@mastodon.social',
      health: 'ready',
      adapterReady: true,
      nextAction: null,
    });
    expect(controllerOptions.clients).toHaveBeenCalledWith({
      instanceUrl: INSTANCE_URL,
      accessToken: ACCESS_TOKEN,
    });
    expect(keychain.values.get(MASTODON_ACCESS_TOKEN_REF)).toBe(ACCESS_TOKEN);
    await expect(controller.createRegistration()).resolves.toMatchObject({
      enabled: true,
      health: 'ready',
      adapter: { definition: { channel: 'mastodon', version: 'mastodon-status@0.1.0' } },
    });
    await expect(controller.createEnabledClient()).resolves.toBeTruthy();
  });

  it('TC-AUTO-MASTODONCHANNEL-127-03 健康失败时不保存 access token', async () => {
    for (const health of ['reauth-required', 'blocked'] as const) {
      const keychain = secrets();
      const controller = new MastodonChannelController(
        options(await root(), keychain.store, client(health)),
      );
      await expect(
        controller.enable({ instanceUrl: INSTANCE_URL, accessToken: ACCESS_TOKEN }),
      ).rejects.toMatchObject({
        code: health === 'reauth-required' ? 'REAUTH_REQUIRED' : 'ADAPTER_UNAVAILABLE',
      });
      expect(keychain.store.put).not.toHaveBeenCalled();
    }
  });

  it('TC-AUTO-MASTODONCHANNEL-127-04 activation 存在但 Keychain 缺失时要求重新接入', async () => {
    const directory = await root();
    await new MastodonActivationStore(directory).enable({
      instanceUrl: INSTANCE_URL,
      alias: 'illegalcreed@mastodon.social',
      accountId: ACCOUNT_ID,
    });
    const controller = new MastodonChannelController(options(directory, secrets().store));

    await expect(controller.getStatus()).resolves.toMatchObject({
      alias: 'illegalcreed@mastodon.social',
      health: 'reauth-required',
      adapterReady: false,
    });
    await expect(controller.createRegistration()).resolves.toBeNull();
  });

  it('TC-AUTO-MASTODONCHANNEL-127-05 activation 与实时身份不一致时失败关闭', async () => {
    const directory = await root();
    await new MastodonActivationStore(directory).enable({
      instanceUrl: INSTANCE_URL,
      alias: 'illegalcreed@mastodon.social',
      accountId: ACCOUNT_ID,
    });
    const keychain = secrets({ [MASTODON_ACCESS_TOKEN_REF]: ACCESS_TOKEN });
    const controller = new MastodonChannelController(
      options(directory, keychain.store, client('ready', 'someone@mastodon.social')),
    );

    await expect(controller.getStatus()).resolves.toMatchObject({
      health: 'blocked',
      adapterReady: false,
    });
    await expect(controller.createEnabledClient()).resolves.toBeNull();
  });

  it('TC-AUTO-MASTODONCHANNEL-127-06 损坏 activation 时失败关闭且不读 Keychain', async () => {
    const directory = await root();
    const keychain = secrets({ [MASTODON_ACCESS_TOKEN_REF]: ACCESS_TOKEN });
    await new MastodonActivationStore(directory).enable({
      instanceUrl: INSTANCE_URL,
      alias: 'illegalcreed@mastodon.social',
      accountId: ACCOUNT_ID,
    });
    await writeFile(join(directory, 'activations', 'mastodon.json'), '{broken', 'utf8');
    const controller = new MastodonChannelController(options(directory, keychain.store));

    await expect(controller.getStatus()).resolves.toMatchObject({
      health: 'blocked',
      adapterReady: false,
    });
    expect(keychain.store.get).not.toHaveBeenCalled();
  });

  it('TC-AUTO-MASTODONCHANNEL-127-07 状态与错误永不泄露 access token', async () => {
    const directory = await root();
    await new MastodonActivationStore(directory).enable({
      instanceUrl: INSTANCE_URL,
      alias: 'illegalcreed@mastodon.social',
      accountId: ACCOUNT_ID,
    });
    const keychain = secrets({ [MASTODON_ACCESS_TOKEN_REF]: ACCESS_TOKEN });
    const failing = client();
    vi.mocked(failing.checkHealth).mockRejectedValueOnce(new Error(`private ${ACCESS_TOKEN}`));
    const status = await new MastodonChannelController(
      options(directory, keychain.store, failing),
    ).getStatus();

    expect(status).toMatchObject({ health: 'blocked', adapterReady: false });
    expect(JSON.stringify(status)).not.toContain(ACCESS_TOKEN);
  });
});
