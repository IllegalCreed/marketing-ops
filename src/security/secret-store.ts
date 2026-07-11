import { spawn } from 'node:child_process';
import { MarketingOpsError } from '../errors.js';

export interface KeychainCommandRequest {
  operation: 'put' | 'get' | 'delete';
  executable: string;
  args: string[];
  stdin?: string;
  env: Record<string, string>;
}

export interface KeychainCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type KeychainCommandRunner = (
  request: KeychainCommandRequest,
) => Promise<KeychainCommandResult>;

const KEYCHAIN_SERVICE = 'cn.illegalscreed.marketing-ops';
const SECRET_REF_PATTERN = /^[a-z0-9][a-z0-9/_-]{1,127}$/;

function validateRef(ref: string): void {
  if (!SECRET_REF_PATTERN.test(ref)) {
    throw new MarketingOpsError('INVALID_INPUT', 'Secret reference is invalid');
  }
}

function validateSecret(value: string): void {
  if (!value || value.length > 16_384 || value.includes('\0')) {
    throw new MarketingOpsError('INVALID_INPUT', 'Secret value is invalid');
  }
}

export const runKeychainCommand: KeychainCommandRunner = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      env: request.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', () => {
      reject(new MarketingOpsError('REAUTH_REQUIRED', 'Keychain helper is unavailable'));
    });
    child.once('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });

    if (request.stdin !== undefined) child.stdin.end(request.stdin);
    else child.stdin.end();
  });

export class MacOsKeychainSecretStore {
  readonly #helperPath: string;
  readonly #runner: KeychainCommandRunner;

  constructor(helperPath: string, runner: KeychainCommandRunner = runKeychainCommand) {
    this.#helperPath = helperPath;
    this.#runner = runner;
  }

  async put(ref: string, value: string): Promise<void> {
    validateRef(ref);
    validateSecret(value);
    await this.#execute('put', ref, value);
  }

  async get(ref: string): Promise<string> {
    validateRef(ref);
    const result = await this.#execute('get', ref);
    if (!result.stdout) {
      throw new MarketingOpsError('REAUTH_REQUIRED', 'Channel authorization is unavailable');
    }
    return result.stdout;
  }

  async delete(ref: string): Promise<void> {
    validateRef(ref);
    await this.#execute('delete', ref);
  }

  async #execute(operation: 'put' | 'get' | 'delete', ref: string, input?: string) {
    const request: KeychainCommandRequest = {
      operation,
      executable: this.#helperPath,
      args: [operation, KEYCHAIN_SERVICE, ref],
      env: {},
      ...(input === undefined ? {} : { stdin: input }),
    };
    let result: KeychainCommandResult;
    try {
      result = await this.#runner(request);
    } catch {
      throw new MarketingOpsError('REAUTH_REQUIRED', 'Keychain access is unavailable');
    }
    if (result.code !== 0) {
      throw new MarketingOpsError('REAUTH_REQUIRED', 'Channel authorization is unavailable');
    }
    return result;
  }
}
