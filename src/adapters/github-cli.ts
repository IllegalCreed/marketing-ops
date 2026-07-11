import { z } from 'zod';
import { AdapterError, AdapterTransportError, type AdapterStage } from './contract.js';
import type {
  GitHubReleaseClient,
  GitHubReleaseDraft,
  GitHubReleaseRecord,
} from './github-release.js';
import {
  runGhProcess,
  type GhProcessInvocation,
  type GhProcessResult,
  type GhProcessRunner,
} from '../runtime/gh-process.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_PATTERN = /^marketing\/[a-z0-9][a-z0-9._-]{0,63}$/;
const RESPONSE_LIMIT_BYTES = 524_288;
const TIMEOUT_MS = 20_000;
const API_VERSION = '2026-03-10';
const PAGE_SCHEMA = z.number().int().min(1).max(10);

const releaseDraftSchema = z
  .object({
    tagName: z.string().regex(TAG_PATTERN),
    name: z.string().min(1).max(512),
    body: z.string().min(1).max(200_000),
    draft: z.literal(false),
    prerelease: z.literal(false),
  })
  .strict();

const issueDraftSchema = z
  .object({
    title: z.string().min(1).max(256),
    body: z.string().min(1).max(100_000),
  })
  .strict();

const githubCliRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('auth-status') }).strict(),
  z.object({ operation: z.literal('viewer') }).strict(),
  z
    .object({
      operation: z.literal('repository'),
      repository: z.string().regex(REPOSITORY_PATTERN),
    })
    .strict(),
  z
    .object({
      operation: z.literal('find-release'),
      repository: z.string().regex(REPOSITORY_PATTERN),
      tagName: z.string().regex(TAG_PATTERN),
    })
    .strict(),
  z
    .object({
      operation: z.literal('create-release'),
      repository: z.string().regex(REPOSITORY_PATTERN),
      release: releaseDraftSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('delete-release'),
      repository: z.string().regex(REPOSITORY_PATTERN),
      releaseId: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('get-release'),
      repository: z.string().regex(REPOSITORY_PATTERN),
      releaseId: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('list-release-reactions'),
      repository: z.string().regex(REPOSITORY_PATTERN),
      releaseId: z.number().int().positive().safe(),
      page: PAGE_SCHEMA,
    })
    .strict(),
  z
    .object({
      operation: z.literal('traffic-views'),
      repository: z.string().regex(REPOSITORY_PATTERN),
    })
    .strict(),
  z
    .object({
      operation: z.literal('traffic-clones'),
      repository: z.string().regex(REPOSITORY_PATTERN),
    })
    .strict(),
  z
    .object({
      operation: z.literal('traffic-referrers'),
      repository: z.string().regex(REPOSITORY_PATTERN),
    })
    .strict(),
  z
    .object({
      operation: z.literal('traffic-paths'),
      repository: z.string().regex(REPOSITORY_PATTERN),
    })
    .strict(),
  z
    .object({
      operation: z.literal('list-issues'),
      repository: z.string().regex(REPOSITORY_PATTERN),
      page: PAGE_SCHEMA,
    })
    .strict(),
  z
    .object({
      operation: z.literal('create-issue'),
      repository: z.string().regex(REPOSITORY_PATTERN),
      issue: issueDraftSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('list-issue-comments'),
      repository: z.string().regex(REPOSITORY_PATTERN),
      issueNumber: z.number().int().positive().safe(),
      page: PAGE_SCHEMA,
    })
    .strict(),
  z
    .object({
      operation: z.literal('get-tag-reference'),
      repository: z.string().regex(REPOSITORY_PATTERN),
      tagName: z.string().regex(TAG_PATTERN),
    })
    .strict(),
  z
    .object({
      operation: z.literal('delete-tag-reference'),
      repository: z.string().regex(REPOSITORY_PATTERN),
      tagName: z.string().regex(TAG_PATTERN),
    })
    .strict(),
]);

export type GitHubCliRequest = z.infer<typeof githubCliRequestSchema>;

const viewerSchema = z
  .object({
    login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
  })
  .strict();

const repositorySchema = z
  .object({
    fullName: z.string().regex(REPOSITORY_PATTERN),
    archived: z.boolean(),
    disabled: z.boolean(),
    permissions: z
      .object({ admin: z.boolean(), maintain: z.boolean(), push: z.boolean() })
      .strict(),
  })
  .strict();

const releaseSchema = z
  .object({
    id: z.number().int().positive().safe(),
    tagName: z.string().regex(TAG_PATTERN),
    name: z.string().min(1).max(512),
    body: z.string().min(1).max(200_000),
    htmlUrl: z.url().startsWith('https://github.com/'),
    publishedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const releaseDetailsSchema = z
  .object({
    id: z.number().int().positive().safe(),
    tagName: z.string().regex(TAG_PATTERN),
    name: z.string().min(1).max(512),
    body: z.string().min(1).max(200_000),
    htmlUrl: z.url().startsWith('https://github.com/'),
    publishedAt: z.iso.datetime({ offset: true }),
    assets: z
      .array(
        z
          .object({
            id: z.number().int().positive().safe(),
            name: z.string().min(1).max(255),
            downloadCount: z.number().int().nonnegative().safe(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

const reactionSchema = z
  .object({
    id: z.number().int().positive().safe(),
    content: z.enum(['+1', 'laugh', 'heart', 'hooray', 'rocket', 'eyes']),
    userLogin: z.string().min(1).max(39).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const reactionsSchema = z.array(reactionSchema).max(100);

const trafficPointSchema = z
  .object({
    timestamp: z.iso.datetime({ offset: true }),
    count: z.number().int().nonnegative().safe(),
    uniques: z.number().int().nonnegative().safe(),
  })
  .strict();
const trafficSeriesSchema = z
  .object({
    count: z.number().int().nonnegative().safe(),
    uniques: z.number().int().nonnegative().safe(),
    points: z.array(trafficPointSchema).max(14),
  })
  .strict();
const trafficReferrersSchema = z
  .array(
    z
      .object({
        referrer: z.string().min(1).max(512),
        count: z.number().int().nonnegative().safe(),
        uniques: z.number().int().nonnegative().safe(),
      })
      .strict(),
  )
  .max(10);
const trafficPathsSchema = z
  .array(
    z
      .object({
        path: z.string().startsWith('/').max(2_000),
        title: z.string().min(1).max(2_000),
        count: z.number().int().nonnegative().safe(),
        uniques: z.number().int().nonnegative().safe(),
      })
      .strict(),
  )
  .max(10);

const issueSchema = z
  .object({
    number: z.number().int().positive().safe(),
    htmlUrl: z.url().startsWith('https://github.com/'),
    title: z.string().min(1).max(256),
    body: z.string().max(100_000),
    state: z.enum(['open', 'closed']),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const issuesSchema = z.array(issueSchema).max(100);
const issueCommentSchema = z
  .object({
    id: z.number().int().positive().safe(),
    htmlUrl: z.url().startsWith('https://github.com/'),
    body: z.string().max(100_000),
    userLogin: z.string().min(1).max(39).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const issueCommentsSchema = z.array(issueCommentSchema).max(100);
const tagReferenceSchema = z
  .object({
    ref: z.string().startsWith('refs/tags/').max(300),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    type: z.enum(['commit', 'tag']),
  })
  .strict();

export type GitHubReleaseDetails = z.infer<typeof releaseDetailsSchema>;
export type GitHubReleaseReaction = z.infer<typeof reactionSchema>;
export type GitHubTrafficSeries = z.infer<typeof trafficSeriesSchema>;
export type GitHubTrafficReferrer = z.infer<typeof trafficReferrersSchema>[number];
export type GitHubTrafficPath = z.infer<typeof trafficPathsSchema>[number];
export type GitHubIssueDraft = z.infer<typeof issueDraftSchema>;
export type GitHubIssueRecord = z.infer<typeof issueSchema>;
export type GitHubIssueComment = z.infer<typeof issueCommentSchema>;
export type GitHubTagReference = z.infer<typeof tagReferenceSchema>;

export interface GitHubCliTransport {
  run(request: GitHubCliRequest): Promise<GhProcessResult>;
}

export type GitHubCliHealthReason =
  | 'READY'
  | 'CLI_NOT_FOUND'
  | 'REAUTH_REQUIRED'
  | 'REPOSITORY_MISMATCH'
  | 'REPOSITORY_BLOCKED'
  | 'WRITE_PERMISSION_REQUIRED'
  | 'TEMPORARY_FAILURE';

export interface GitHubCliHealth {
  alias: string | null;
  health: 'ready' | 'not-configured' | 'reauth-required' | 'blocked';
  reason: GitHubCliHealthReason;
}

class GitHubCliUnavailableError extends Error {
  readonly reason: 'not-found' | 'failed';

  constructor(reason: 'not-found' | 'failed') {
    super('GitHub CLI is unavailable');
    this.name = 'GitHubCliUnavailableError';
    this.reason = reason;
  }
}

const VIEWER_PROJECTION = '{login: .login}';
const REPOSITORY_PROJECTION =
  '{fullName: .full_name, archived: .archived, disabled: .disabled, permissions: {admin: .permissions.admin, maintain: .permissions.maintain, push: .permissions.push}}';
const RELEASE_PROJECTION =
  '{id: .id, tagName: .tag_name, name: .name, body: .body, htmlUrl: .html_url, publishedAt: .published_at}';
const RELEASE_DETAILS_PROJECTION =
  '{id: .id, tagName: .tag_name, name: .name, body: .body, htmlUrl: .html_url, publishedAt: .published_at, assets: [.assets[] | {id: .id, name: .name, downloadCount: .download_count}]}';
const REACTIONS_PROJECTION =
  '[.[] | {id: .id, content: .content, userLogin: .user.login, createdAt: .created_at}]';
const TRAFFIC_VIEWS_PROJECTION =
  '{count: .count, uniques: .uniques, points: [.views[] | {timestamp: .timestamp, count: .count, uniques: .uniques}]}';
const TRAFFIC_CLONES_PROJECTION =
  '{count: .count, uniques: .uniques, points: [.clones[] | {timestamp: .timestamp, count: .count, uniques: .uniques}]}';
const TRAFFIC_REFERRERS_PROJECTION =
  '[.[] | {referrer: .referrer, count: .count, uniques: .uniques}]';
const TRAFFIC_PATHS_PROJECTION =
  '[.[] | {path: .path, title: .title, count: .count, uniques: .uniques}]';
const ISSUES_PROJECTION =
  '[.[] | select(.pull_request == null) | {number: .number, htmlUrl: .html_url, title: .title, body: (.body // ""), state: .state, createdAt: .created_at, updatedAt: .updated_at}]';
const ISSUE_PROJECTION =
  '{number: .number, htmlUrl: .html_url, title: .title, body: (.body // ""), state: .state, createdAt: .created_at, updatedAt: .updated_at}';
const ISSUE_COMMENTS_PROJECTION =
  '[.[] | {id: .id, htmlUrl: .html_url, body: (.body // ""), userLogin: .user.login, createdAt: .created_at, updatedAt: .updated_at}]';
const TAG_REFERENCE_PROJECTION = '{ref: .ref, sha: .object.sha, type: .object.type}';

function baseArgs(endpoint: string, method: 'GET' | 'POST' | 'DELETE'): string[] {
  return [
    'api',
    endpoint,
    '--method',
    method,
    '--hostname',
    'github.com',
    '--header',
    'Accept: application/vnd.github+json',
    '--header',
    `X-GitHub-Api-Version: ${API_VERSION}`,
  ];
}

function projectedInvocation(
  endpoint: string,
  method: 'GET' | 'POST',
  projection: string,
  stdin: string | null = null,
): GhProcessInvocation {
  const args = [...baseArgs(endpoint, method), '--jq', projection];
  if (stdin !== null) args.push('--input', '-');
  return { args, stdin, timeoutMs: TIMEOUT_MS, maxOutputBytes: RESPONSE_LIMIT_BYTES };
}

export function buildGitHubCliInvocation(value: unknown): GhProcessInvocation {
  const request = githubCliRequestSchema.parse(value);
  if (request.operation === 'auth-status') {
    return {
      args: ['auth', 'status', '--active', '--hostname', 'github.com'],
      stdin: null,
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: RESPONSE_LIMIT_BYTES,
    };
  }
  if (request.operation === 'viewer') {
    return projectedInvocation('user', 'GET', VIEWER_PROJECTION);
  }
  if (request.operation === 'repository') {
    return projectedInvocation(`repos/${request.repository}`, 'GET', REPOSITORY_PROJECTION);
  }
  if (request.operation === 'find-release') {
    return projectedInvocation(
      `repos/${request.repository}/releases/tags/${encodeURIComponent(request.tagName)}`,
      'GET',
      RELEASE_PROJECTION,
    );
  }
  if (request.operation === 'create-release') {
    const body = JSON.stringify({
      tag_name: request.release.tagName,
      name: request.release.name,
      body: request.release.body,
      draft: false,
      prerelease: false,
    });
    return projectedInvocation(
      `repos/${request.repository}/releases`,
      'POST',
      RELEASE_PROJECTION,
      body,
    );
  }
  if (request.operation === 'get-release') {
    return projectedInvocation(
      `repos/${request.repository}/releases/${request.releaseId}`,
      'GET',
      RELEASE_DETAILS_PROJECTION,
    );
  }
  if (request.operation === 'list-release-reactions') {
    return projectedInvocation(
      `repos/${request.repository}/releases/${request.releaseId}/reactions?per_page=100&page=${request.page}`,
      'GET',
      REACTIONS_PROJECTION,
    );
  }
  if (request.operation === 'traffic-views') {
    return projectedInvocation(
      `repos/${request.repository}/traffic/views?per=day`,
      'GET',
      TRAFFIC_VIEWS_PROJECTION,
    );
  }
  if (request.operation === 'traffic-clones') {
    return projectedInvocation(
      `repos/${request.repository}/traffic/clones?per=day`,
      'GET',
      TRAFFIC_CLONES_PROJECTION,
    );
  }
  if (request.operation === 'traffic-referrers') {
    return projectedInvocation(
      `repos/${request.repository}/traffic/popular/referrers`,
      'GET',
      TRAFFIC_REFERRERS_PROJECTION,
    );
  }
  if (request.operation === 'traffic-paths') {
    return projectedInvocation(
      `repos/${request.repository}/traffic/popular/paths`,
      'GET',
      TRAFFIC_PATHS_PROJECTION,
    );
  }
  if (request.operation === 'list-issues') {
    return projectedInvocation(
      `repos/${request.repository}/issues?state=all&sort=created&direction=desc&per_page=100&page=${request.page}`,
      'GET',
      ISSUES_PROJECTION,
    );
  }
  if (request.operation === 'create-issue') {
    return projectedInvocation(
      `repos/${request.repository}/issues`,
      'POST',
      ISSUE_PROJECTION,
      JSON.stringify(request.issue),
    );
  }
  if (request.operation === 'list-issue-comments') {
    return projectedInvocation(
      `repos/${request.repository}/issues/${request.issueNumber}/comments?per_page=100&page=${request.page}`,
      'GET',
      ISSUE_COMMENTS_PROJECTION,
    );
  }
  if (request.operation === 'get-tag-reference') {
    return projectedInvocation(
      `repos/${request.repository}/git/ref/tags/${request.tagName}`,
      'GET',
      TAG_REFERENCE_PROJECTION,
    );
  }
  if (request.operation === 'delete-tag-reference') {
    return {
      args: [
        ...baseArgs(`repos/${request.repository}/git/refs/tags/${request.tagName}`, 'DELETE'),
        '--silent',
      ],
      stdin: null,
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: RESPONSE_LIMIT_BYTES,
    };
  }
  if (request.operation !== 'delete-release') {
    throw new AdapterError('INVALID_CONTENT', 'Unsupported GitHub CLI operation', {
      retryable: false,
    });
  }
  return {
    args: [
      ...baseArgs(`repos/${request.repository}/releases/${request.releaseId}`, 'DELETE'),
      '--silent',
    ],
    stdin: null,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: RESPONSE_LIMIT_BYTES,
  };
}

export class GitHubCliProcessTransport implements GitHubCliTransport {
  readonly #runner: GhProcessRunner;

  constructor(runner: GhProcessRunner = runGhProcess) {
    this.#runner = runner;
  }

  async run(request: GitHubCliRequest): Promise<GhProcessResult> {
    return this.#runner(buildGitHubCliInvocation(request));
  }
}

function httpStatus(result: GhProcessResult): number | undefined {
  const match = /\bHTTP\s+(\d{3})\b/i.exec(result.stderr);
  return match ? Number(match[1]) : undefined;
}

function retryAfter(result: GhProcessResult): number | undefined {
  const match = /\bRetry-After:\s*(\d+)\b/i.exec(result.stderr);
  return match ? Number(match[1]) : undefined;
}

function throwFailure(result: GhProcessResult, stage: AdapterStage): never {
  if (result.spawnError) throw new GitHubCliUnavailableError(result.spawnError);
  if (result.outputLimitExceeded) {
    if (stage === 'after-submit') {
      throw new AdapterError(
        'UNKNOWN_RESULT',
        'GitHub CLI output exceeded its safety limit; lookup is required',
        { retryable: false, stage, lookupRequired: true },
      );
    }
    throw new AdapterTransportError('GitHub CLI output exceeded its safety limit', {
      status: 502,
      stage,
    });
  }
  const status = httpStatus(result);
  if (status === 422) {
    throw new AdapterError('INVALID_CONTENT', 'GitHub rejected the release content', {
      retryable: false,
      stage,
    });
  }
  if (stage === 'after-submit' && status === undefined && !result.timedOut) {
    throw new AdapterError(
      'UNKNOWN_RESULT',
      'GitHub CLI result is unknown; lookup is required before retry',
      { retryable: false, stage, lookupRequired: true },
    );
  }
  const retryAfterSeconds = retryAfter(result);
  const message = result.timedOut ? 'GitHub CLI request timed out' : 'GitHub CLI request failed';
  if (result.timedOut) {
    throw new AdapterTransportError(message, {
      ...(status === undefined ? {} : { status }),
      timeout: true,
      stage,
    });
  }
  if (status !== undefined && retryAfterSeconds !== undefined) {
    throw new AdapterTransportError(message, { status, retryAfterSeconds, stage });
  }
  if (status !== undefined) throw new AdapterTransportError(message, { status, stage });
  throw new AdapterTransportError(message, { stage });
}

function requireSuccess(result: GhProcessResult, stage: AdapterStage): string {
  if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded || result.spawnError) {
    throwFailure(result, stage);
  }
  if (Buffer.byteLength(result.stdout) > RESPONSE_LIMIT_BYTES) {
    throwFailure({ ...result, outputLimitExceeded: true }, stage);
  }
  return result.stdout;
}

function parseResponse<T>(schema: z.ZodType<T>, raw: string, stage: AdapterStage): T {
  try {
    return schema.parse(JSON.parse(raw) as unknown);
  } catch {
    if (stage === 'after-submit') {
      throw new AdapterError(
        'UNKNOWN_RESULT',
        'GitHub returned an invalid response; lookup is required',
        { retryable: false, stage, lookupRequired: true },
      );
    }
    throw new AdapterError('TEMPORARY_FAILURE', 'GitHub returned an invalid response', {
      retryable: true,
      stage,
    });
  }
}

export class GitHubCliClient implements GitHubReleaseClient {
  readonly #transport: GitHubCliTransport;

  constructor(transport: GitHubCliTransport = new GitHubCliProcessTransport()) {
    this.#transport = transport;
  }

  async getViewer(): Promise<{ login: string }> {
    const result = await this.#transport.run({ operation: 'viewer' });
    return parseResponse(viewerSchema, requireSuccess(result, 'before-submit'), 'before-submit');
  }

  async getRepository(repository: string): Promise<z.infer<typeof repositorySchema>> {
    const request = githubCliRequestSchema.parse({ operation: 'repository', repository });
    const result = await this.#transport.run(request);
    return parseResponse(
      repositorySchema,
      requireSuccess(result, 'before-submit'),
      'before-submit',
    );
  }

  async findReleaseByTag(repository: string, tagName: string): Promise<GitHubReleaseRecord | null> {
    const request = githubCliRequestSchema.parse({
      operation: 'find-release',
      repository,
      tagName,
    });
    const result = await this.#transport.run(request);
    if (result.exitCode !== 0 && httpStatus(result) === 404) return null;
    return parseResponse(releaseSchema, requireSuccess(result, 'before-submit'), 'before-submit');
  }

  async createRelease(
    repository: string,
    release: GitHubReleaseDraft,
  ): Promise<GitHubReleaseRecord> {
    const request = githubCliRequestSchema.parse({
      operation: 'create-release',
      repository,
      release,
    });
    const result = await this.#transport.run(request);
    return parseResponse(releaseSchema, requireSuccess(result, 'after-submit'), 'after-submit');
  }

  async deleteRelease(repository: string, releaseId: number): Promise<'deleted' | 'not-found'> {
    const request = githubCliRequestSchema.parse({
      operation: 'delete-release',
      repository,
      releaseId,
    });
    const result = await this.#transport.run(request);
    if (result.exitCode !== 0 && httpStatus(result) === 404) return 'not-found';
    requireSuccess(result, 'after-submit');
    return 'deleted';
  }

  async getRelease(repository: string, releaseId: number): Promise<GitHubReleaseDetails> {
    const request = githubCliRequestSchema.parse({
      operation: 'get-release',
      repository,
      releaseId,
    });
    const result = await this.#transport.run(request);
    return parseResponse(
      releaseDetailsSchema,
      requireSuccess(result, 'before-submit'),
      'before-submit',
    );
  }

  async listReleaseReactions(
    repository: string,
    releaseId: number,
    page: number,
  ): Promise<GitHubReleaseReaction[]> {
    const request = githubCliRequestSchema.parse({
      operation: 'list-release-reactions',
      repository,
      releaseId,
      page,
    });
    const result = await this.#transport.run(request);
    return parseResponse(reactionsSchema, requireSuccess(result, 'before-submit'), 'before-submit');
  }

  async getTrafficViews(repository: string): Promise<GitHubTrafficSeries> {
    return this.#readRepositoryObservation('traffic-views', repository, trafficSeriesSchema);
  }

  async getTrafficClones(repository: string): Promise<GitHubTrafficSeries> {
    return this.#readRepositoryObservation('traffic-clones', repository, trafficSeriesSchema);
  }

  async getTrafficReferrers(repository: string): Promise<GitHubTrafficReferrer[]> {
    return this.#readRepositoryObservation('traffic-referrers', repository, trafficReferrersSchema);
  }

  async getTrafficPaths(repository: string): Promise<GitHubTrafficPath[]> {
    return this.#readRepositoryObservation('traffic-paths', repository, trafficPathsSchema);
  }

  async listIssues(repository: string, page: number): Promise<GitHubIssueRecord[]> {
    const request = githubCliRequestSchema.parse({
      operation: 'list-issues',
      repository,
      page,
    });
    const result = await this.#transport.run(request);
    return parseResponse(issuesSchema, requireSuccess(result, 'before-submit'), 'before-submit');
  }

  async createIssue(repository: string, issue: GitHubIssueDraft): Promise<GitHubIssueRecord> {
    const request = githubCliRequestSchema.parse({ operation: 'create-issue', repository, issue });
    const result = await this.#transport.run(request);
    return parseResponse(issueSchema, requireSuccess(result, 'after-submit'), 'after-submit');
  }

  async listIssueComments(
    repository: string,
    issueNumber: number,
    page: number,
  ): Promise<GitHubIssueComment[]> {
    const request = githubCliRequestSchema.parse({
      operation: 'list-issue-comments',
      repository,
      issueNumber,
      page,
    });
    const result = await this.#transport.run(request);
    return parseResponse(
      issueCommentsSchema,
      requireSuccess(result, 'before-submit'),
      'before-submit',
    );
  }

  async findTagReference(repository: string, tagName: string): Promise<GitHubTagReference | null> {
    const request = githubCliRequestSchema.parse({
      operation: 'get-tag-reference',
      repository,
      tagName,
    });
    const result = await this.#transport.run(request);
    if (result.exitCode !== 0 && httpStatus(result) === 404) return null;
    return parseResponse(
      tagReferenceSchema,
      requireSuccess(result, 'before-submit'),
      'before-submit',
    );
  }

  async deleteTagReference(repository: string, tagName: string): Promise<'deleted' | 'not-found'> {
    const request = githubCliRequestSchema.parse({
      operation: 'delete-tag-reference',
      repository,
      tagName,
    });
    const result = await this.#transport.run(request);
    if (result.exitCode !== 0 && httpStatus(result) === 404) return 'not-found';
    requireSuccess(result, 'after-submit');
    return 'deleted';
  }

  async #readRepositoryObservation<T>(
    operation: 'traffic-views' | 'traffic-clones' | 'traffic-referrers' | 'traffic-paths',
    repository: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const request = githubCliRequestSchema.parse({ operation, repository });
    const result = await this.#transport.run(request);
    return parseResponse(schema, requireSuccess(result, 'before-submit'), 'before-submit');
  }

  async checkHealth(repository: string): Promise<GitHubCliHealth> {
    let alias: string | null = null;
    try {
      const authStatus = await this.#transport.run({ operation: 'auth-status' });
      if (authStatus.spawnError === 'not-found') {
        return { alias: null, health: 'not-configured', reason: 'CLI_NOT_FOUND' };
      }
      if (
        authStatus.spawnError ||
        authStatus.timedOut ||
        authStatus.outputLimitExceeded ||
        authStatus.exitCode === null
      ) {
        return { alias: null, health: 'blocked', reason: 'TEMPORARY_FAILURE' };
      }
      if (authStatus.exitCode !== 0) {
        return { alias: null, health: 'reauth-required', reason: 'REAUTH_REQUIRED' };
      }
      alias = (await this.getViewer()).login;
      const metadata = await this.getRepository(repository);
      if (metadata.fullName.toLowerCase() !== repository.toLowerCase()) {
        return { alias, health: 'blocked', reason: 'REPOSITORY_MISMATCH' };
      }
      if (metadata.archived || metadata.disabled) {
        return { alias, health: 'blocked', reason: 'REPOSITORY_BLOCKED' };
      }
      if (
        !metadata.permissions.admin &&
        !metadata.permissions.maintain &&
        !metadata.permissions.push
      ) {
        return { alias, health: 'blocked', reason: 'WRITE_PERMISSION_REQUIRED' };
      }
      return { alias, health: 'ready', reason: 'READY' };
    } catch (error) {
      if (error instanceof GitHubCliUnavailableError && error.reason === 'not-found') {
        return { alias: null, health: 'not-configured', reason: 'CLI_NOT_FOUND' };
      }
      if (error instanceof AdapterTransportError && error.status === 401) {
        return { alias: null, health: 'reauth-required', reason: 'REAUTH_REQUIRED' };
      }
      return { alias, health: 'blocked', reason: 'TEMPORARY_FAILURE' };
    }
  }
}
