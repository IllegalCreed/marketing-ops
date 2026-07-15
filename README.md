# Marketing Ops

Local, credential-isolated campaign operations for the Algorithm Visualizer project.

## Current scope

T2 established the seven-tool MCP contract, guided local onboarding boundaries, macOS Keychain and browser Profile isolation, campaign locking, and sanitized receipt storage.

T3-A upgrades the contract to v2 so `publish_campaign` receives deterministic channel packages from the public renderer. It adds the shared adapter contract, idempotent dispatch, and a GitHub Release adapter.

T3-B adds a fixed, typed `gh api` client for GitHub Releases, read-only CLI/account/repository health checks, and a separate local activation gate. GitHub authentication may be healthy while `adapterReady` remains `false`; the default runtime performs no write until `marketing-ops setup github` succeeds. The client never accepts arbitrary endpoints or arguments, never reads token environment variables, and sends release bodies through standard input instead of process arguments.

T3-C adds strict Release detail/reaction, repository traffic, Issue/comment, status, feedback, report, and known-receipt deletion operations. Repository traffic is always labeled as a latest-14-day repository observation and never attributed to one campaign. Release deletion also verifies the stored marker and removes the adapter-owned `marketing/<campaignId>` Git tag; a pre-existing unowned tag blocks publication. Receipt reads and deletion updates reject non-private, linked, oversized, duplicated, or malformed files.

The owner-authorized T3-C smoke completed successfully. Its temporary Release and adapter-owned tag were deleted, the persisted receipt is marked deleted, and GitHub remains ready/enabled. Later writes still require explicit owner authorization for the matching campaign.

T3-D1-A adds a fixed process boundary for official `@weibo-ai/weibo-cli@0.8.3`, sanitized `doctor` health, and a read-only available `statuses` command catalog. It strips token and secret environment variables, exposes no raw CLI response, and keeps the production Weibo adapter disabled. A typed injected client verifies the text-post, lookup, idempotency, receipt, and error contract without logging in or writing to Weibo.

T3-D1-B completed device OAuth and personal developer verification. The official dashboard plan catalog checked on 2026-07-14 exposes Free as a seven-day, zero-price, own-data-only trial with five reads per hour and zero writes. The trial has not been activated, no account command catalog has been read, and production publishing remains disabled. Free readiness must never be presented as a publish capability; zero-cost Weibo publishing requires a separately reviewed browser-automation path.

T3-D2 adds the fixed official `@atproto/api@0.20.28` boundary for English Bluesky text posts. Setup accepts a public handle and a dedicated App Password only through an interactive TTY, validates the live handle and DID before storing the secret in macOS Keychain, and writes only the public handle/DID activation record locally. The runtime registers the adapter lazily for a requested Bluesky package and rechecks Keychain, activation, and live identity before every registration. One-time setup completed on 2026-07-14 and the channel is ready/enabled. `bluesky-text@0.2.0` can remove only this adapter's exact published receipt after the AT URI, public URL, and authenticated DID match. The owner-authorized `marketing-ops-t3d2-smoke-127` publish/read/idempotency/delete smoke completed and was cleaned up on 2026-07-14; its receipt is deleted and the AT Protocol record is absent. Later campaign writes still require separate matching authorization.

T3-D3 adds a fixed DEV/Forem v1 HTTP boundary using Node's built-in `fetch`. It only calls the documented authenticated-user, article, and comment endpoints under `https://dev.to/api`, sends the required Forem v1 `Accept` header, caps responses at 2 MB, and scans at most ten pages without automatic write retries. `dev-article@0.1.0` accepts one English, media-free renderer package, adds a hashed hidden marker, publishes with the project canonical URL, and reports article-level reactions/comments. Comment bodies remain explicitly untrusted. DEV author keys do not expose a true delete endpoint, so `reply=false` and `delete=false`; page views also remain unavailable until a stable typed response is verified. The adapter, hidden setup path, Keychain/0600 activation gate, runtime, and zero-side-effect campaign preflight are complete. One-time setup completed on 2026-07-15; status/doctor remain ready/enabled. The owner-authorized `marketing-ops-t3d3-smoke-127` then completed publish, exact public API body readback, same-receipt idempotency replay, feedback, and `1h` report reads. Receipt `4146005` is published and the article remains public by design.

`all-or-none` calls must name an explicit channel set and provide one renderer package for every requested channel. The plugin rejects an unverifiable `all-authorized` set before any adapter can write.

## Commands

```bash
pnpm install
pnpm verify
pnpm build
node dist/cli.js setup
node dist/cli.js setup github
node dist/cli.js setup bluesky
node dist/cli.js status
node dist/cli.js doctor
pnpm test:github-readonly
```

`status` and `doctor` may temporarily report stale developer-verification state while the official account service propagates an approved review. Do not run `auth token`, export credentials, activate a paid plan, or guess dynamic Weibo platform actions.

For Bluesky, create a dedicated App Password in the official account settings immediately before one-time setup. Never use or enter the main account password. Setup health does not authorize a campaign write; a matching campaign still requires explicit owner authorization.

For DEV, generate a dedicated API key from the account extensions settings, then run `node dist/cli.js setup dev` in an interactive terminal. The key is entered without echo and stored only in macOS Keychain. Setup performs a read-only `/users/me` identity check; it does not publish an article or authorize a later campaign.

Never pass a password, token, Cookie, or browser Profile through command-line arguments, environment variables, JSON files, chat, logs, or MCP tool inputs.
