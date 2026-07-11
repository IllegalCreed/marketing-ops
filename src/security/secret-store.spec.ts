import { describe, expect, it } from 'vitest';
import {
  MacOsKeychainSecretStore,
  runKeychainCommand,
  type KeychainCommandRequest,
} from './secret-store.js';

describe('marketing-ops Keychain adapter', () => {
  it('TC-AUTO-SECRET-127-01 只按 opaque ref 操作且 secret 仅走 stdin', async () => {
    const requests: KeychainCommandRequest[] = [];
    const runner = async (request: KeychainCommandRequest) => {
      requests.push(request);
      if (request.operation === 'get') return { code: 0, stdout: 'stored-value', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const store = new MacOsKeychainSecretStore('/private/keychain-helper', runner);

    await store.put('channel/dev/api-key', 'private-value');
    await expect(store.get('channel/dev/api-key')).resolves.toBe('stored-value');
    await store.delete('channel/dev/api-key');

    const serializedArgs = JSON.stringify(requests.map(({ args, env }) => ({ args, env })));
    expect(serializedArgs).not.toContain('private-value');
    expect(requests[0]?.stdin).toBe('private-value');
    expect(requests.every((request) => request.executable === '/private/keychain-helper')).toBe(
      true,
    );
    expect(Object.getOwnPropertyNames(MacOsKeychainSecretStore.prototype)).not.toEqual(
      expect.arrayContaining(['list', 'export']),
    );

    await expect(
      runKeychainCommand({
        operation: 'put',
        executable: process.execPath,
        args: ['-e', 'process.stdin.pipe(process.stdout)'],
        stdin: 'pipe-value',
        env: {},
      }),
    ).resolves.toMatchObject({ code: 0, stdout: 'pipe-value', stderr: '' });
    await expect(
      runKeychainCommand({
        operation: 'get',
        executable: process.execPath,
        args: ['-e', 'process.stderr.write("expected"); process.exit(2)'],
        env: {},
      }),
    ).resolves.toMatchObject({ code: 2, stdout: '', stderr: 'expected' });
    await expect(
      runKeychainCommand({
        operation: 'get',
        executable: process.execPath,
        args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
        env: {},
      }),
    ).resolves.toMatchObject({ code: 1 });
  });

  it('TC-AUTO-SECRET-127-02 缺失或拒绝统一为脱敏 REAUTH_REQUIRED', async () => {
    const store = new MacOsKeychainSecretStore('/private/keychain-helper', async () => ({
      code: 44,
      stdout: '',
      stderr: 'denied private-value',
    }));

    await expect(store.get('channel/dev/api-key')).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });
    try {
      await store.get('channel/dev/api-key');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('private-value');
    }

    const emptyStore = new MacOsKeychainSecretStore('/private/keychain-helper', async () => ({
      code: 0,
      stdout: '',
      stderr: '',
    }));
    await expect(emptyStore.get('channel/dev/api-key')).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });

    const throwingStore = new MacOsKeychainSecretStore('/private/keychain-helper', async () => {
      throw new Error('private-value');
    });
    await expect(throwingStore.delete('channel/dev/api-key')).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });

    const defaultStore = new MacOsKeychainSecretStore('/definitely/missing/keychain-helper');
    await expect(defaultStore.get('channel/dev/api-key')).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });

    for (const invalidRef of ['', '../escape', 'UPPERCASE']) {
      await expect(store.get(invalidRef)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.delete(invalidRef)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    for (const invalidSecret of ['', 'x'.repeat(16_385), 'null\0byte']) {
      await expect(store.put('channel/dev/api-key', invalidSecret)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
  });
});
