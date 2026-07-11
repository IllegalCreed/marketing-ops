import { spawn } from 'node:child_process';

export interface WeiboProcessInvocation {
  args: readonly string[];
  stdin: string | null;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface WeiboProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError: 'not-found' | 'failed' | null;
}

interface WeiboChildProcess {
  stdin: { end(value?: string): void };
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  once(event: 'error', listener: (error: unknown) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

interface WeiboSpawnOptions {
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ['pipe', 'pipe', 'pipe'];
  windowsHide: true;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: WeiboSpawnOptions,
) => WeiboChildProcess;

interface WeiboProcessRunnerOptions {
  spawnProcess?: SpawnProcess;
  environment?: Readonly<NodeJS.ProcessEnv>;
}

export type WeiboProcessRunner = (
  invocation: WeiboProcessInvocation,
) => Promise<WeiboProcessResult>;

const SAFE_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'XDG_CONFIG_HOME',
] as const;

export function safeWeiboEnvironment(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = { NO_COLOR: '1', NODE_ENV: 'production' };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: WeiboSpawnOptions,
): WeiboChildProcess {
  return spawn(command, [...args], options);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function initialResult(): WeiboProcessResult {
  return {
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputLimitExceeded: false,
    spawnError: null,
  };
}

export function createWeiboProcessRunner(
  options: WeiboProcessRunnerOptions = {},
): WeiboProcessRunner {
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const environment = safeWeiboEnvironment(options.environment ?? process.env);

  return async (invocation) =>
    new Promise<WeiboProcessResult>((resolve) => {
      let child: WeiboChildProcess;
      try {
        child = spawnProcess('weibo', invocation.args, {
          env: environment,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        resolve({
          ...initialResult(),
          spawnError: errorCode(error) === 'ENOENT' ? 'not-found' : 'failed',
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let settled = false;
      const complete = (result: Partial<WeiboProcessResult>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ...initialResult(), stdout, stderr, ...result });
      };
      const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
        if (settled) return;
        const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        outputBytes += Buffer.byteLength(value);
        if (outputBytes > invocation.maxOutputBytes) {
          child.kill('SIGKILL');
          complete({ outputLimitExceeded: true, stdout: '', stderr: '' });
          return;
        }
        if (target === 'stdout') stdout += value;
        else stderr += value;
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        complete({ timedOut: true });
      }, invocation.timeoutMs);

      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
      child.once('error', (error) => {
        complete({ spawnError: errorCode(error) === 'ENOENT' ? 'not-found' : 'failed' });
      });
      child.once('close', (exitCode) => complete({ exitCode }));
      child.stdin.end(invocation.stdin ?? undefined);
    });
}

export const runWeiboProcess = createWeiboProcessRunner();
