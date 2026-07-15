import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevActivationStore } from './dev-activation-store.js';
import {
  DEV_API_KEY_REF,
  DevChannelController,
  type DevChannelClient,
  type DevSecretStore,
} from './dev-channel.js';

const API_KEY = 'dev-api-key-abcdefghijklmnop';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'marketing-ops-dev-channel-'));
  roots.push(value);
  return value;
}

function secrets(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const store: DevSecretStore = {
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
  userId = 12345,
): DevChannelClient {
  return {
    checkHealth: vi.fn(async () => ({
      health,
      alias: health === 'ready' ? 'algorithmviz' : null,
      userId: health === 'ready' ? userId : null,
      reason:
        health === 'ready'
          ? ('READY' as const)
          : health === 'reauth-required'
            ? ('REAUTH_REQUIRED' as const)
            : ('UNAVAILABLE' as const),
    })),
    findArticle: vi.fn(async () => ({ complete: true, article: null })),
    createArticle: vi.fn(),
    getArticle: vi.fn(),
    listComments: vi.fn(),
  };
}

function options(directory: string, secretStore: DevSecretStore, value = client()) {
  return {
    clients: vi.fn(() => value),
    activations: new DevActivationStore(directory),
    secrets: secretStore,
  };
}

describe('DEV channel controller', () => {
  it('TC-AUTO-DEVCHANNEL-127-01 无 activation 时不读取 Keychain 或构造 client', async () => {
    const keychain = secrets();
    const controllerOptions = options(await root(), keychain.store);
    const controller = new DevChannelController(controllerOptions);

    await expect(controller.getStatus()).resolves.toEqual({
      channel: 'dev',
      alias: null,
      health: 'not-configured',
      adapterReady: false,
      nextAction: 'Run marketing-ops setup dev',
    });
    await expect(controller.createRegistration()).resolves.toBeNull();
    expect(keychain.store.get).not.toHaveBeenCalled();
    expect(controllerOptions.clients).not.toHaveBeenCalled();
  });

  it('TC-AUTO-DEVCHANNEL-127-02 setup 先验证身份，再保存 Keychain 与 activation', async () => {
    const directory = await root();
    const keychain = secrets();
    const controllerOptions = options(directory, keychain.store);
    const controller = new DevChannelController(controllerOptions);

    await expect(controller.enable(API_KEY)).resolves.toEqual({
      channel: 'dev',
      alias: 'algorithmviz',
      health: 'ready',
      adapterReady: true,
      nextAction: null,
    });
    expect(controllerOptions.clients).toHaveBeenCalledWith(API_KEY);
    expect(keychain.values.get(DEV_API_KEY_REF)).toBe(API_KEY);
    await expect(controller.createRegistration()).resolves.toMatchObject({
      enabled: true,
      health: 'ready',
      adapter: { definition: { channel: 'dev', version: 'dev-article@0.1.0' } },
    });
    await expect(controller.createEnabledClient()).resolves.toBeTruthy();
  });

  it('TC-AUTO-DEVCHANNEL-127-03 健康失败时不保存 API key', async () => {
    for (const health of ['reauth-required', 'blocked'] as const) {
      const keychain = secrets();
      const controller = new DevChannelController(
        options(await root(), keychain.store, client(health)),
      );
      await expect(controller.enable(API_KEY)).rejects.toMatchObject({
        code: health === 'reauth-required' ? 'REAUTH_REQUIRED' : 'ADAPTER_UNAVAILABLE',
      });
      expect(keychain.store.put).not.toHaveBeenCalled();
    }
  });

  it('TC-AUTO-DEVCHANNEL-127-04 activation 存在但 Keychain 缺失时要求重新接入', async () => {
    const directory = await root();
    await new DevActivationStore(directory).enable({ username: 'algorithmviz', userId: 12345 });
    const controller = new DevChannelController(options(directory, secrets().store));

    await expect(controller.getStatus()).resolves.toMatchObject({
      alias: 'algorithmviz',
      health: 'reauth-required',
      adapterReady: false,
    });
    await expect(controller.createRegistration()).resolves.toBeNull();
  });

  it('TC-AUTO-DEVCHANNEL-127-05 activation 与实时身份不一致时失败关闭', async () => {
    const directory = await root();
    await new DevActivationStore(directory).enable({ username: 'algorithmviz', userId: 12345 });
    const keychain = secrets({ [DEV_API_KEY_REF]: API_KEY });
    const controller = new DevChannelController(
      options(directory, keychain.store, client('ready', 999)),
    );

    await expect(controller.getStatus()).resolves.toMatchObject({
      health: 'blocked',
      adapterReady: false,
    });
    await expect(controller.createEnabledClient()).resolves.toBeNull();

    const reauth = new DevChannelController(
      options(directory, keychain.store, client('reauth-required')),
    );
    await expect(reauth.getStatus()).resolves.toMatchObject({
      health: 'reauth-required',
      adapterReady: false,
    });
  });

  it('TC-AUTO-DEVCHANNEL-127-06 损坏 activation 时失败关闭且不读 Keychain', async () => {
    const directory = await root();
    const keychain = secrets({ [DEV_API_KEY_REF]: API_KEY });
    await new DevActivationStore(directory).enable({ username: 'algorithmviz', userId: 12345 });
    await writeFile(join(directory, 'activations', 'dev.json'), '{broken', 'utf8');
    const controller = new DevChannelController(options(directory, keychain.store));

    await expect(controller.getStatus()).resolves.toMatchObject({
      health: 'blocked',
      adapterReady: false,
    });
    expect(keychain.store.get).not.toHaveBeenCalled();
  });

  it('TC-AUTO-DEVCHANNEL-127-07 状态与错误永不泄露 API key', async () => {
    const directory = await root();
    await new DevActivationStore(directory).enable({ username: 'algorithmviz', userId: 12345 });
    const keychain = secrets({ [DEV_API_KEY_REF]: API_KEY });
    const failing = client();
    vi.mocked(failing.checkHealth).mockRejectedValueOnce(new Error(`private ${API_KEY}`));
    const status = await new DevChannelController(
      options(directory, keychain.store, failing),
    ).getStatus();

    expect(status).toMatchObject({ health: 'blocked', adapterReady: false });
    expect(JSON.stringify(status)).not.toContain(API_KEY);
  });
});
