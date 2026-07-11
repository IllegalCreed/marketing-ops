import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createWeiboProcessRunner,
  safeWeiboEnvironment,
  type WeiboProcessInvocation,
} from './runtime/weibo-process.js';

function createChild() {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}

const INVOCATION: WeiboProcessInvocation = {
  args: ['doctor', '--output', 'json'],
  stdin: null,
  timeoutMs: 100,
  maxOutputBytes: 1024,
};

describe('Weibo official CLI process boundary', () => {
  it('TC-AUTO-WBPROC-127-01 固定 weibo、无 shell 且不继承任何 token 环境变量', async () => {
    const child = createChild();
    let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
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
        spawnedEnvironment = options.env;
        return child;
      },
    );
    const runner = createWeiboProcessRunner({
      spawnProcess,
      environment: {
        PATH: '/usr/bin',
        HOME: '/Users/demo',
        LANG: 'zh_CN.UTF-8',
        WEIBO_CLI_TOKEN: 'private-access',
        WEIBO_TOKEN: 'private-access-2',
        WEIBO_CLI_REFRESH_TOKEN: 'private-refresh',
        WEIBO_REFRESH_TOKEN: 'private-refresh-2',
        WBCLI_PASSWORD: 'private-keychain-value',
        NPM_TOKEN: 'private-npm-token',
      },
    });
    const completed = runner(INVOCATION);
    child.stdout.end('{"ready":false}');
    child.emit('close', 0, null);

    await expect(completed).resolves.toMatchObject({
      exitCode: 0,
      stdout: '{"ready":false}',
      timedOut: false,
      outputLimitExceeded: false,
      spawnError: null,
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      'weibo',
      INVOCATION.args,
      expect.objectContaining({
        shell: false,
        env: expect.objectContaining({
          PATH: '/usr/bin',
          HOME: '/Users/demo',
          LANG: 'zh_CN.UTF-8',
          NO_COLOR: '1',
          NODE_ENV: 'production',
        }),
      }),
    );
    for (const key of [
      'WEIBO_CLI_TOKEN',
      'WEIBO_TOKEN',
      'WEIBO_CLI_REFRESH_TOKEN',
      'WEIBO_REFRESH_TOKEN',
      'WBCLI_PASSWORD',
      'NPM_TOKEN',
    ]) {
      expect(spawnedEnvironment).not.toHaveProperty(key);
    }
    expect(safeWeiboEnvironment({ WEIBO_TOKEN: 'secret' })).not.toHaveProperty('WEIBO_TOKEN');
  });

  it('TC-AUTO-WBPROC-127-02 超时、输出超限、异步与同步 ENOENT 均结构化失败', async () => {
    vi.useFakeTimers();
    try {
      const timeoutChild = createChild();
      const timeoutRunner = createWeiboProcessRunner({
        spawnProcess: vi.fn(() => timeoutChild),
        environment: {},
      });
      const timeout = timeoutRunner({ ...INVOCATION, timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      await expect(timeout).resolves.toMatchObject({ timedOut: true, spawnError: null });
      expect(timeoutChild.kill).toHaveBeenCalledOnce();

      const limitChild = createChild();
      const limitRunner = createWeiboProcessRunner({
        spawnProcess: vi.fn(() => limitChild),
        environment: {},
      });
      const limited = limitRunner({ ...INVOCATION, maxOutputBytes: 3 });
      limitChild.stderr.write('private-path-and-token');
      await expect(limited).resolves.toMatchObject({ outputLimitExceeded: true });
      expect(limitChild.kill).toHaveBeenCalledOnce();

      const missingChild = createChild();
      const missingRunner = createWeiboProcessRunner({
        spawnProcess: vi.fn(() => missingChild),
        environment: {},
      });
      const missing = missingRunner(INVOCATION);
      missingChild.emit(
        'error',
        Object.assign(new Error('/private/bin/weibo'), { code: 'ENOENT' }),
      );
      await expect(missing).resolves.toMatchObject({ spawnError: 'not-found' });

      const syncMissing = createWeiboProcessRunner({
        spawnProcess: () => {
          throw Object.assign(new Error('/private/bin/weibo'), { code: 'ENOENT' });
        },
        environment: {},
      });
      const output = await syncMissing(INVOCATION);
      expect(output).toMatchObject({ spawnError: 'not-found', stdout: '', stderr: '' });
      expect(JSON.stringify(output)).not.toContain('/private');

      const syncFailed = createWeiboProcessRunner({
        spawnProcess: () => {
          throw new Error('/private/bin/weibo failed');
        },
        environment: {},
      });
      await expect(syncFailed(INVOCATION)).resolves.toMatchObject({
        spawnError: 'failed',
        stdout: '',
        stderr: '',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
