# Marketing Ops

Local, credential-isolated campaign operations for the Algorithm Visualizer project.

## Current scope

T2 established the seven-tool MCP contract, guided local onboarding boundaries, macOS Keychain and browser Profile isolation, campaign locking, and sanitized receipt storage.

T3-A upgrades the contract to v2 so `publish_campaign` receives deterministic channel packages from the public renderer. It adds the shared adapter contract, idempotent dispatch, and a GitHub Release adapter.

T3-B adds a fixed, typed `gh api` client for GitHub Releases, read-only CLI/account/repository health checks, and a separate local activation gate. GitHub authentication may be healthy while `adapterReady` remains `false`; the default runtime performs no write until `marketing-ops setup github` succeeds. The client never accepts arbitrary endpoints or arguments, never reads token environment variables, and sends release bodies through standard input instead of process arguments. No real GitHub write smoke has been performed yet.

T3-C adds strict Release detail/reaction, repository traffic, Issue/comment, status, feedback, report, and known-receipt deletion operations. Repository traffic is always labeled as a latest-14-day repository observation and never attributed to one campaign. Release deletion also verifies the stored marker and removes the adapter-owned `marketing/<campaignId>` Git tag; a pre-existing unowned tag blocks publication. Receipt reads and deletion updates reject non-private, linked, oversized, duplicated, or malformed files.

The T3-C read-only smoke currently confirms that GitHub health, traffic, and Issue reads are available and that both the reserved smoke Release and Git tag are absent. Local activation is still absent, `adapterReady` is still `false`, and no GitHub write has been performed. A temporary create/read/delete smoke requires explicit owner authorization for the frozen smoke campaign.

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

Never pass a password, token, Cookie, or browser Profile through command-line arguments, environment variables, JSON files, chat, logs, or MCP tool inputs.
