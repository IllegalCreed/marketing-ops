# Marketing Ops

Local, credential-isolated campaign operations for the Algorithm Visualizer project.

## Current scope

T2 establishes the seven-tool MCP contract, guided local onboarding boundaries, macOS Keychain and browser Profile isolation, campaign locking, and sanitized receipt storage. Platform adapters and real publishing begin in T3; this version must fail closed instead of attempting a network write.

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
