import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlueskyActivationStore } from './bluesky-activation-store.js';
import {
  BLUESKY_APP_PASSWORD_REF,
  BLUESKY_HANDLE_REF,
  BlueskyChannelController,
  type BlueskyChannelClient,
  type BlueskySecretStore,
} from './bluesky-channel.js';

const HANDLE = 'algorithms-visualization.bsky.social';
const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), 'marketing-ops-bluesky-channel-'));
  roots.push(value);
  return value;
}

function secrets(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const store: BlueskySecretStore = {
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
  did: string = DID,
): BlueskyChannelClient {
  return {
    checkHealth: vi.fn(async () => ({
      health,
      alias: health === 'ready' ? HANDLE : null,
      did: health === 'ready' ? did : null,
      reason:
        health === 'ready'
          ? ('READY' as const)
          : health === 'reauth-required'
            ? ('REAUTH_REQUIRED' as const)
            : ('UNAVAILABLE' as const),
    })),
    findRecentPostByText: vi.fn(async () => ({ complete: true, post: null })),
    createTextPost: vi.fn(),
  };
}

function controllerOptions(
  directory: string,
  secretStore: BlueskySecretStore,
  value: BlueskyChannelClient = client(),
) {
  return {
    clients: vi.fn(() => value),
    activations: new BlueskyActivationStore(directory),
    secrets: secretStore,
  };
}

describe('Bluesky channel controller', () => {
  it('TC-AUTO-BSKYCHANNEL-127-01 无 activation 时不读取 Keychain 或注册 adapter', async () => {
    const directory = await root();
    const keychain = secrets();
    const options = controllerOptions(directory, keychain.store);
    const controller = new BlueskyChannelController(options);

    await expect(controller.getStatus()).resolves.toEqual({
      channel: 'bluesky',
      alias: null,
      health: 'not-configured',
      adapterReady: false,
      nextAction: 'Run marketing-ops setup bluesky',
    });
    await expect(controller.createRegistration()).resolves.toBeNull();
    expect(keychain.store.get).not.toHaveBeenCalled();
    expect(options.clients).not.toHaveBeenCalled();
  });

  it('TC-AUTO-BSKYCHANNEL-127-02 setup 先验证身份，再保存 Keychain 并显式启用', async () => {
    const directory = await root();
    const keychain = secrets();
    const fake = client();
    const options = controllerOptions(directory, keychain.store, fake);
    const controller = new BlueskyChannelController(options);

    await expect(
      controller.enable({ handle: `@${HANDLE}`, appPassword: APP_PASSWORD }),
    ).resolves.toEqual({
      channel: 'bluesky',
      alias: HANDLE,
      health: 'ready',
      adapterReady: true,
      nextAction: null,
    });
    expect(options.clients).toHaveBeenCalledWith({ handle: HANDLE, appPassword: APP_PASSWORD });
    expect(keychain.values.get(BLUESKY_HANDLE_REF)).toBe(HANDLE);
    expect(keychain.values.get(BLUESKY_APP_PASSWORD_REF)).toBe(APP_PASSWORD);

    await expect(controller.createRegistration()).resolves.toMatchObject({
      enabled: true,
      health: 'ready',
      adapter: { definition: { channel: 'bluesky', version: 'bluesky-text@0.1.0' } },
    });
  });

  it('TC-AUTO-BSKYCHANNEL-127-03 认证或平台健康失败时不保存任何凭据', async () => {
    for (const health of ['reauth-required', 'blocked'] as const) {
      const keychain = secrets();
      const controller = new BlueskyChannelController(
        controllerOptions(await root(), keychain.store, client(health)),
      );

      await expect(
        controller.enable({ handle: HANDLE, appPassword: APP_PASSWORD }),
      ).rejects.toMatchObject({
        code: health === 'reauth-required' ? 'REAUTH_REQUIRED' : 'ADAPTER_UNAVAILABLE',
      });
      expect(keychain.store.put).not.toHaveBeenCalled();
    }
  });

  it('TC-AUTO-BSKYCHANNEL-127-03B setup 返回其他账号时不保存任何凭据', async () => {
    const directory = await root();
    const keychain = secrets();
    const mismatched = client();
    vi.mocked(mismatched.checkHealth).mockResolvedValueOnce({
      health: 'ready',
      alias: 'different-account.bsky.social',
      did: DID,
      reason: 'READY',
    });
    const controller = new BlueskyChannelController(
      controllerOptions(directory, keychain.store, mismatched),
    );

    await expect(
      controller.enable({ handle: HANDLE, appPassword: APP_PASSWORD }),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    expect(keychain.store.put).not.toHaveBeenCalled();
  });

  it('TC-AUTO-BSKYCHANNEL-127-04 已启用但 Keychain 缺失时要求重新接入', async () => {
    const directory = await root();
    await new BlueskyActivationStore(directory).enable({ handle: HANDLE, did: DID });
    const keychain = secrets();
    const controller = new BlueskyChannelController(controllerOptions(directory, keychain.store));

    await expect(controller.getStatus()).resolves.toEqual({
      channel: 'bluesky',
      alias: HANDLE,
      health: 'reauth-required',
      adapterReady: false,
      nextAction: 'Run marketing-ops setup bluesky',
    });
    await expect(controller.createRegistration()).resolves.toBeNull();
  });

  it('TC-AUTO-BSKYCHANNEL-127-05 activation 与实时 DID 不一致时失败关闭', async () => {
    const directory = await root();
    await new BlueskyActivationStore(directory).enable({ handle: HANDLE, did: DID });
    const keychain = secrets({
      [BLUESKY_HANDLE_REF]: HANDLE,
      [BLUESKY_APP_PASSWORD_REF]: APP_PASSWORD,
    });
    const controller = new BlueskyChannelController(
      controllerOptions(
        directory,
        keychain.store,
        client('ready', 'did:plc:differentidentityvalue'),
      ),
    );

    await expect(controller.getStatus()).resolves.toMatchObject({
      channel: 'bluesky',
      alias: HANDLE,
      health: 'blocked',
      adapterReady: false,
      nextAction: 'Run marketing-ops setup bluesky',
    });
    await expect(controller.createRegistration()).resolves.toBeNull();
  });

  it('TC-AUTO-BSKYCHANNEL-127-06 重新认证状态不泄露凭据', async () => {
    const directory = await root();
    const keychain = secrets();
    await new BlueskyActivationStore(directory).enable({ handle: HANDLE, did: DID });
    keychain.values.set(BLUESKY_HANDLE_REF, HANDLE);
    keychain.values.set(BLUESKY_APP_PASSWORD_REF, APP_PASSWORD);
    const controller = new BlueskyChannelController(
      controllerOptions(directory, keychain.store, client('reauth-required')),
    );

    const status = await controller.getStatus();
    expect(status).toMatchObject({ health: 'reauth-required', adapterReady: false });
    expect(JSON.stringify(status)).not.toContain(APP_PASSWORD);
  });

  it('TC-AUTO-BSKYCHANNEL-127-07 损坏 activation 时失败关闭且不读取 Keychain', async () => {
    const directory = await root();
    const keychain = secrets({
      [BLUESKY_HANDLE_REF]: HANDLE,
      [BLUESKY_APP_PASSWORD_REF]: APP_PASSWORD,
    });
    await new BlueskyActivationStore(directory).enable({ handle: HANDLE, did: DID });
    await writeFile(join(directory, 'activations', 'bluesky.json'), '{broken', 'utf8');
    const controller = new BlueskyChannelController(controllerOptions(directory, keychain.store));

    await expect(controller.getStatus()).resolves.toMatchObject({
      health: 'blocked',
      adapterReady: false,
    });
    expect(keychain.store.get).not.toHaveBeenCalled();
  });

  it('TC-AUTO-BSKYCHANNEL-127-08 activation 与 Keychain handle 不一致时失败关闭', async () => {
    const directory = await root();
    const keychain = secrets({
      [BLUESKY_HANDLE_REF]: 'different-account.bsky.social',
      [BLUESKY_APP_PASSWORD_REF]: APP_PASSWORD,
    });
    await new BlueskyActivationStore(directory).enable({ handle: HANDLE, did: DID });
    const options = controllerOptions(directory, keychain.store);
    const controller = new BlueskyChannelController(options);

    await expect(controller.getStatus()).resolves.toMatchObject({
      alias: HANDLE,
      health: 'blocked',
      adapterReady: false,
    });
    expect(options.clients).not.toHaveBeenCalled();
  });

  it('TC-AUTO-BSKYCHANNEL-127-09 健康检查抛错时失败关闭', async () => {
    const directory = await root();
    const keychain = secrets({
      [BLUESKY_HANDLE_REF]: HANDLE,
      [BLUESKY_APP_PASSWORD_REF]: APP_PASSWORD,
    });
    await new BlueskyActivationStore(directory).enable({ handle: HANDLE, did: DID });
    const failing = client();
    vi.mocked(failing.checkHealth).mockRejectedValueOnce(new Error(`private ${APP_PASSWORD}`));
    const controller = new BlueskyChannelController(
      controllerOptions(directory, keychain.store, failing),
    );

    const status = await controller.getStatus();
    expect(status).toMatchObject({ alias: HANDLE, health: 'blocked', adapterReady: false });
    expect(JSON.stringify(status)).not.toContain(APP_PASSWORD);
  });
});
