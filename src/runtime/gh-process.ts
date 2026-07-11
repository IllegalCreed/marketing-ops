import { spawn } from 'node:child_process';

export interface GhProcessInvocation {
  args: readonly string[];
  stdin: string | null;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface GhProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError: 'not-found' | 'failed' | null;
}

interface GhChildProcess {
  stdin: { end(value?: string): void };
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  once(event: 'error', listener: (error: unknown) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

interface GhSpawnOptions {
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ['pipe', 'pipe', 'pipe'];
  windowsHide: true;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: GhSpawnOptions,
) => GhChildProcess;

interface GhProcessRunnerOptions {
  spawnProcess?: SpawnProcess;
  environment?: Readonly<NodeJS.ProcessEnv>;
}

export type GhProcessRunner = (invocation: GhProcessInvocation) => Promise<GhProcessResult>;

const SAFE_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'XDG_CONFIG_HOME',
  'GH_CONFIG_DIR',
] as const;

export function safeGhEnvironment(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    NO_COLOR: '1',
  };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: GhSpawnOptions,
): GhChildProcess {
  return spawn(command, [...args], options);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function initialResult(): GhProcessResult {
  return {
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputLimitExceeded: false,
    spawnError: null,
  };
}

export function createGhProcessRunner(options: GhProcessRunnerOptions = {}): GhProcessRunner {
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const environment = safeGhEnvironment(options.environment ?? process.env);

  return async (invocation) =>
    new Promise<GhProcessResult>((resolve) => {
      let child: GhChildProcess;
      try {
        child = spawnProcess('gh', invocation.args, {
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
      const complete = (result: Partial<GhProcessResult>) => {
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
          complete({ outputLimitExceeded: true });
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

export const runGhProcess = createGhProcessRunner();
