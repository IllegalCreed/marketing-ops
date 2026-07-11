import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createGhProcessRunner,
  safeGhEnvironment,
  type GhProcessInvocation,
} from './runtime/gh-process.js';

function createChild() {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
  });
  return child;
}

const INVOCATION: GhProcessInvocation = {
  args: ['api', 'user', '--method', 'GET'],
  stdin: null,
  timeoutMs: 100,
  maxOutputBytes: 1024,
};

describe('GitHub CLI process boundary', () => {
  it('TC-AUTO-GHCLI-127-06 固定 gh、无 shell 且不继承 secret env', async () => {
    const child = createChild();
    let spawnedOptions:
      | {
          env: NodeJS.ProcessEnv;
          shell: false;
          stdio: ['pipe', 'pipe', 'pipe'];
          windowsHide: true;
        }
      | undefined;
    const spawnProcess = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        options: {
          env: NodeJS.ProcessEnv;
          shell: false;
          stdio: ['pipe', 'pipe', 'pipe'];
          windowsHide: true;
        },
      ) => {
        spawnedOptions = options;
        return child;
      },
    );
    const runner = createGhProcessRunner({
      spawnProcess,
      environment: {
        PATH: '/usr/bin',
        HOME: '/Users/demo',
        GH_TOKEN: 'private-token',
        GITHUB_TOKEN: 'private-token-2',
        LANG: 'en_US.UTF-8',
      },
    });
    const completed = runner(INVOCATION);
    child.stdout.end('{"login":"IllegalCreed"}');
    child.stderr.end('safe warning');
    child.emit('close', 0, null);

    await expect(completed).resolves.toMatchObject({
      exitCode: 0,
      stdout: '{"login":"IllegalCreed"}',
      stderr: 'safe warning',
      timedOut: false,
      outputLimitExceeded: false,
      spawnError: null,
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      'gh',
      INVOCATION.args,
      expect.objectContaining({
        shell: false,
        env: expect.objectContaining({
          PATH: '/usr/bin',
          HOME: '/Users/demo',
          GH_PROMPT_DISABLED: '1',
          GH_PAGER: 'cat',
          NO_COLOR: '1',
        }),
      }),
    );
    const processEnv = spawnedOptions?.env;
    expect(processEnv).not.toHaveProperty('GH_TOKEN');
    expect(processEnv).not.toHaveProperty('GITHUB_TOKEN');
    expect(safeGhEnvironment({ GH_TOKEN: 'private-token' })).not.toHaveProperty('GH_TOKEN');
  });

  it('TC-AUTO-GHCLI-127-06 超时、输出超限与 ENOENT 结构化失败', async () => {
    vi.useFakeTimers();
    try {
      const timeoutChild = createChild();
      const timeoutRunner = createGhProcessRunner({
        spawnProcess: vi.fn(() => timeoutChild),
        environment: {},
      });
      const timeout = timeoutRunner({ ...INVOCATION, timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      await expect(timeout).resolves.toMatchObject({ timedOut: true, spawnError: null });
      expect(timeoutChild.kill).toHaveBeenCalledOnce();

      const limitChild = createChild();
      const limitRunner = createGhProcessRunner({
        spawnProcess: vi.fn(() => limitChild),
        environment: {},
      });
      const limited = limitRunner({ ...INVOCATION, maxOutputBytes: 3 });
      limitChild.stdout.write('four');
      await expect(limited).resolves.toMatchObject({ outputLimitExceeded: true });
      expect(limitChild.kill).toHaveBeenCalledOnce();

      const missingChild = createChild();
      const missingRunner = createGhProcessRunner({
        spawnProcess: vi.fn(() => missingChild),
        environment: {},
      });
      const missing = missingRunner(INVOCATION);
      missingChild.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
      await expect(missing).resolves.toMatchObject({ spawnError: 'not-found' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('TC-AUTO-GHCLI-127-06 同步 spawn 失败也不抛出内部路径', async () => {
    const missing = createGhProcessRunner({
      spawnProcess: () => {
        throw Object.assign(new Error('/private/bin/gh missing'), { code: 'ENOENT' });
      },
      environment: {},
    });
    await expect(missing(INVOCATION)).resolves.toMatchObject({ spawnError: 'not-found' });

    const failed = createGhProcessRunner({
      spawnProcess: () => {
        throw new Error('/private/internal/failure');
      },
      environment: {},
    });
    const output = await failed(INVOCATION);
    expect(output).toMatchObject({ spawnError: 'failed', stderr: '', stdout: '' });
    expect(JSON.stringify(output)).not.toContain('/private');
  });
});
