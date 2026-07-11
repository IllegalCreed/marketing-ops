import { z } from 'zod';
import {
  AdapterError,
  AdapterTransportError,
  mapAdapterTransportError,
  type AdapterStage,
} from './contract.js';
import {
  runWeiboProcess,
  type WeiboProcessInvocation,
  type WeiboProcessResult,
  type WeiboProcessRunner,
} from '../runtime/weibo-process.js';

const TIMEOUT_MS = 20_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const ACTION_PATTERN = /^[a-z][a-z0-9_]{0,63}(?:\/[a-z][a-z0-9_]{0,63})?$/;

const requestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('doctor') }).strict(),
  z.object({ operation: z.literal('available-status-commands') }).strict(),
]);

export type WeiboCliRequest = z.infer<typeof requestSchema>;

const doctorSchema = z
  .object({
    ready: z.boolean(),
    steps: z
      .object({
        login: z.boolean(),
        developerVerification: z.boolean(),
        subscription: z.boolean(),
      })
      .strict(),
    user: z
      .object({ username: z.string().trim().min(1).max(100) })
      .passthrough()
      .optional(),
    subscription: z
      .object({
        plan: z.object({ name: z.string().trim().min(1).max(100) }).passthrough(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const commandCatalogSchema = z
  .object({
    commands: z
      .array(
        z
          .object({
            group: z.literal('statuses'),
            action: z.string().regex(ACTION_PATTERN),
            access: z.literal('allowed').optional(),
          })
          .passthrough(),
      )
      .max(100),
  })
  .passthrough();

export interface WeiboCliTransport {
  run(request: WeiboCliRequest): Promise<WeiboProcessResult>;
}

export type WeiboCliHealthReason =
  | 'READY'
  | 'CLI_NOT_FOUND'
  | 'LOGIN_REQUIRED'
  | 'DEVELOPER_VERIFICATION_REQUIRED'
  | 'FREE_PLAN_REQUIRED'
  | 'ZERO_COST_PLAN_REQUIRED'
  | 'TEMPORARY_FAILURE';

export interface WeiboCliHealth {
  alias: string | null;
  health: 'ready' | 'not-configured' | 'reauth-required' | 'blocked';
  reason: WeiboCliHealthReason;
  gates: { login: boolean; developerVerification: boolean; freePlan: boolean };
}

class WeiboCliUnavailableError extends Error {
  readonly reason: 'not-found' | 'failed';

  constructor(reason: 'not-found' | 'failed') {
    super('Weibo CLI is unavailable');
    this.name = 'WeiboCliUnavailableError';
    this.reason = reason;
  }
}

function parseRequest(value: unknown): WeiboCliRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdapterError('INVALID_CONTENT', 'Unsupported Weibo CLI operation', {
      retryable: false,
    });
  }
  return parsed.data;
}

export function buildWeiboCliInvocation(value: unknown): WeiboProcessInvocation {
  const request = parseRequest(value);
  const args =
    request.operation === 'doctor'
      ? ['doctor', '--output', 'json']
      : ['commands', 'list', '--available', '--group', 'statuses', '--output', 'json'];
  return { args, stdin: null, timeoutMs: TIMEOUT_MS, maxOutputBytes: RESPONSE_LIMIT_BYTES };
}

export class WeiboCliProcessTransport implements WeiboCliTransport {
  readonly #runner: WeiboProcessRunner;

  constructor(runner: WeiboProcessRunner = runWeiboProcess) {
    this.#runner = runner;
  }

  async run(request: WeiboCliRequest): Promise<WeiboProcessResult> {
    return this.#runner(buildWeiboCliInvocation(request));
  }
}

function httpStatus(result: WeiboProcessResult): number | undefined {
  const match = /\bHTTP\s+(\d{3})\b/i.exec(result.stderr);
  return match ? Number(match[1]) : undefined;
}

function retryAfter(result: WeiboProcessResult): number | undefined {
  const match = /\bRetry-After:\s*(\d+)\b/i.exec(result.stderr);
  return match ? Number(match[1]) : undefined;
}

function looksLikeAuthenticationFailure(result: WeiboProcessResult): boolean {
  return /(?:auth|authorization|expired|login|token|登录|令牌|授权)/i.test(result.stderr);
}

function throwFailure(result: WeiboProcessResult, stage: AdapterStage): never {
  if (result.spawnError) throw new WeiboCliUnavailableError(result.spawnError);
  if (result.outputLimitExceeded) {
    throw new AdapterTransportError('Weibo CLI output exceeded its safety limit', {
      status: 502,
      stage,
    });
  }
  const status = httpStatus(result);
  const effectiveStatus = status ?? (looksLikeAuthenticationFailure(result) ? 401 : undefined);
  if (result.timedOut) {
    throw new AdapterTransportError('Weibo CLI request timed out', {
      ...(effectiveStatus === undefined ? {} : { status: effectiveStatus }),
      timeout: true,
      stage,
    });
  }
  const retryAfterSeconds = retryAfter(result);
  if (effectiveStatus !== undefined && retryAfterSeconds !== undefined) {
    throw new AdapterTransportError('Weibo CLI request failed', {
      status: effectiveStatus,
      retryAfterSeconds,
      stage,
    });
  }
  if (effectiveStatus !== undefined) {
    throw new AdapterTransportError('Weibo CLI request failed', {
      status: effectiveStatus,
      stage,
    });
  }
  throw new AdapterTransportError('Weibo CLI request failed', { stage });
}

function requireSuccess(result: WeiboProcessResult): string {
  if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded || result.spawnError) {
    throwFailure(result, 'before-submit');
  }
  return result.stdout;
}

function parseResponse<T>(schema: z.ZodType<T>, raw: string): T {
  try {
    return schema.parse(JSON.parse(raw) as unknown);
  } catch {
    throw new AdapterError('TEMPORARY_FAILURE', 'Weibo CLI returned an invalid response', {
      retryable: true,
      stage: 'before-submit',
    });
  }
}

const EMPTY_GATES = Object.freeze({
  login: false,
  developerVerification: false,
  freePlan: false,
});

function isZeroCostPlan(name: string | undefined): boolean {
  return name !== undefined && /(?:^free$|free\s+trial|trial|免费|试用)/i.test(name);
}

export class WeiboCliClient {
  readonly #transport: WeiboCliTransport;

  constructor(transport: WeiboCliTransport = new WeiboCliProcessTransport()) {
    this.#transport = transport;
  }

  async checkHealth(): Promise<WeiboCliHealth> {
    try {
      const result = await this.#transport.run({ operation: 'doctor' });
      if (result.spawnError === 'not-found') {
        return {
          alias: null,
          health: 'not-configured',
          reason: 'CLI_NOT_FOUND',
          gates: { ...EMPTY_GATES },
        };
      }
      const doctor = parseResponse(doctorSchema, requireSuccess(result));
      const gates = {
        login: doctor.steps.login,
        developerVerification: doctor.steps.developerVerification,
        freePlan: doctor.steps.subscription && isZeroCostPlan(doctor.subscription?.plan.name),
      };
      const alias = doctor.user?.username ?? null;
      if (!gates.login) {
        return { alias: null, health: 'reauth-required', reason: 'LOGIN_REQUIRED', gates };
      }
      if (!gates.developerVerification) {
        return {
          alias,
          health: 'blocked',
          reason: 'DEVELOPER_VERIFICATION_REQUIRED',
          gates,
        };
      }
      if (!doctor.steps.subscription) {
        return { alias, health: 'blocked', reason: 'FREE_PLAN_REQUIRED', gates };
      }
      if (!gates.freePlan) {
        return { alias, health: 'blocked', reason: 'ZERO_COST_PLAN_REQUIRED', gates };
      }
      if (!doctor.ready || alias === null) {
        return { alias, health: 'blocked', reason: 'TEMPORARY_FAILURE', gates };
      }
      return { alias, health: 'ready', reason: 'READY', gates };
    } catch (error) {
      if (error instanceof WeiboCliUnavailableError && error.reason === 'not-found') {
        return {
          alias: null,
          health: 'not-configured',
          reason: 'CLI_NOT_FOUND',
          gates: { ...EMPTY_GATES },
        };
      }
      if (error instanceof AdapterTransportError && error.status === 401) {
        return {
          alias: null,
          health: 'reauth-required',
          reason: 'LOGIN_REQUIRED',
          gates: { ...EMPTY_GATES },
        };
      }
      return {
        alias: null,
        health: 'blocked',
        reason: 'TEMPORARY_FAILURE',
        gates: { ...EMPTY_GATES },
      };
    }
  }

  async listAvailableStatusActions(): Promise<string[]> {
    try {
      const result = await this.#transport.run({ operation: 'available-status-commands' });
      const catalog = parseResponse(commandCatalogSchema, requireSuccess(result));
      const actions = catalog.commands.map((command) => command.action);
      if (new Set(actions).size !== actions.length) {
        throw new AdapterError('TEMPORARY_FAILURE', 'Weibo CLI returned duplicate commands', {
          retryable: true,
          stage: 'before-submit',
        });
      }
      return actions.toSorted();
    } catch (error) {
      throw mapAdapterTransportError(error);
    }
  }
}
