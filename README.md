# Marketing Ops

Local, credential-isolated campaign operations for the Algorithm Visualizer project.

## Current scope

T2 established the seven-tool MCP contract, guided local onboarding boundaries, macOS Keychain and browser Profile isolation, campaign locking, and sanitized receipt storage.

T3-A upgrades the contract to v2 so `publish_campaign` receives deterministic channel packages from the public renderer. It adds the shared adapter contract, idempotent dispatch, and a GitHub Release adapter tested only through an injected typed fake client. The default server still has no live client, account authorization, or enabled platform adapter and must fail closed instead of attempting a network write.

`all-or-none` calls must name an explicit channel set and provide one renderer package for every requested channel. The plugin rejects an unverifiable `all-authorized` set before any adapter can write.

## Commands

```bash
pnpm install
pnpm verify
pnpm build
node dist/cli.js setup
node dist/cli.js status
node dist/cli.js doctor
```

Never pass a password, token, Cookie, or browser Profile through command-line arguments, environment variables, JSON files, chat, logs, or MCP tool inputs.
