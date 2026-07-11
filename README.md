# Marketing Ops

Local, credential-isolated campaign operations for the Algorithm Visualizer project.

## Current scope

T2 established the seven-tool MCP contract, guided local onboarding boundaries, macOS Keychain and browser Profile isolation, campaign locking, and sanitized receipt storage.

T3-A upgrades the contract to v2 so `publish_campaign` receives deterministic channel packages from the public renderer. It adds the shared adapter contract, idempotent dispatch, and a GitHub Release adapter.

T3-B adds a fixed, typed `gh api` client for GitHub Releases, read-only CLI/account/repository health checks, and a separate local activation gate. GitHub authentication may be healthy while `adapterReady` remains `false`; the default runtime performs no write until `marketing-ops setup github` succeeds. The client never accepts arbitrary endpoints or arguments, never reads token environment variables, and sends release bodies through standard input instead of process arguments.

T3-C adds strict Release detail/reaction, repository traffic, Issue/comment, status, feedback, report, and known-receipt deletion operations. Repository traffic is always labeled as a latest-14-day repository observation and never attributed to one campaign. Release deletion also verifies the stored marker and removes the adapter-owned `marketing/<campaignId>` Git tag; a pre-existing unowned tag blocks publication. Receipt reads and deletion updates reject non-private, linked, oversized, duplicated, or malformed files.

The owner-authorized T3-C smoke completed successfully. Its temporary Release and adapter-owned tag were deleted, the persisted receipt is marked deleted, and GitHub remains ready/enabled. Later writes still require explicit owner authorization for the matching campaign.

T3-D1-A adds a fixed process boundary for official `@weibo-ai/weibo-cli@0.8.3`, sanitized `doctor` health, and a read-only available `statuses` command catalog. It strips token and secret environment variables, exposes no raw CLI response, and keeps the production Weibo adapter disabled. A typed injected client verifies the text-post, lookup, idempotency, receipt, and error contract without logging in or writing to Weibo. Official OAuth, personal developer verification, zero-cost plan activation, command freezing, and live publish are later gates.

`all-or-none` calls must name an explicit channel set and provide one renderer package for every requested channel. The plugin rejects an unverifiable `all-authorized` set before any adapter can write.

## Commands

```bash
pnpm install
pnpm verify
pnpm build
node dist/cli.js setup
node dist/cli.js setup github
node dist/cli.js status
node dist/cli.js doctor
pnpm test:github-readonly
```

`status` and `doctor` may report that the official Weibo CLI is not configured; this is expected until the guided T3-D1-B setup. Do not run `auth token`, export credentials, or guess dynamic Weibo platform actions.

Never pass a password, token, Cookie, or browser Profile through command-line arguments, environment variables, JSON files, chat, logs, or MCP tool inputs.
