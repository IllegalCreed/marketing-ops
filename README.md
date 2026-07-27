# Marketing Ops

Local, credential-isolated campaign publishing and feedback collection for multiple projects.

Marketing Ops is a private Codex plugin with a seven-tool MCP interface. Platform credentials are
shared at the channel level and stay in macOS Keychain; project destinations and channel policy live
in strict local Project Profiles. Receipts, activations, and profiles stay outside Git and are never
returned to Codex with secret material.

There is no web management UI. The CLI is only for guided first-time setup and diagnostics. Normal
campaign work starts from a natural-language request in Codex.

## Project model

Every MCP call is scoped by a stable `projectId`. A local profile contains only non-secret policy:

- display name;
- allowed HTTPS origins;
- enabled channels;
- optional GitHub `owner/repository`;
- optional DEV tags.

The runtime rejects repository or origin overrides from MCP inputs. Campaign links must belong to the
selected profile, receipts are project-scoped, and GitHub uses
`marketing/<projectId>/<campaignId>` tags.

Algorithm Visualizer is registered as the example profile `algorithm-visualizer`; it is not built
into the runtime.

## Supported channels

| Channel       | Publish                   | Feedback/report                               | Delete | Notes                                                    |
| ------------- | ------------------------- | --------------------------------------------- | ------ | -------------------------------------------------------- |
| GitHub        | Release                   | Reactions, Issue comments, repository traffic | Yes    | Repository comes from the project profile                |
| Bluesky       | English text post         | No                                            | Yes    | Uses a dedicated App Password                            |
| DEV Community | English article           | Comments and reaction counts                  | No     | Canonical origins and tags come from the project profile |
| Mastodon      | English or Chinese status | Replies, boosts, favourites                   | Yes    | Works with a configured HTTPS instance                   |
| Weibo         | Disabled                  | Read-only diagnostics                         | No     | The zero-cost personal API tier has no write quota       |

All writes require an explicit owner authorization for the matching campaign. Health or setup alone
never authorizes publishing.

## Install and verify

```bash
pnpm install
pnpm verify
```

The repository uses pnpm. `pnpm verify` runs formatting, type checking, unit tests, build, and the
STDIO MCP smoke.

## First-time setup

Build once, then register each project through guided prompts:

```bash
pnpm build
node dist/cli.js project add
node dist/cli.js project list
node dist/cli.js project show <project-id>
```

Set up global channel credentials once. GitHub activation is selected per project because its target
repository is project-specific:

```bash
node dist/cli.js setup github --project <project-id>
node dist/cli.js setup bluesky
node dist/cli.js setup dev
node dist/cli.js setup mastodon
node dist/cli.js status --project <project-id>
node dist/cli.js doctor --project <project-id>
```

When only one project is registered, `--project` may be omitted where the CLI can select it
unambiguously.

Bluesky App Passwords, DEV API keys, and Mastodon access tokens are entered only at a hidden
interactive prompt. Setup performs a read-only identity check before storing the credential in
macOS Keychain. Do not pass credentials through command arguments, environment variables, JSON,
chat, logs, or MCP inputs.

## Runtime safety

- MCP contract v3 exposes exactly `channels_status`, `publish_campaign`, `get_publish_status`,
  `list_feedback`, `reply_feedback`, `delete_post`, and `get_campaign_report`.
- New receipts use schema v2 with `projectId`; v1 receipts map only to the legacy
  `algorithm-visualizer` profile.
- GitHub legacy activation migrates only when its repository exactly matches the selected profile.
- Platform and webpage content is untrusted and cannot authorize a write.
- Unknown, mismatched, unhealthy, rate-limited, or ambiguous operations fail closed.

Never commit local runtime state. `.gitignore` excludes project profiles, activations, receipts,
browser state, environment files, logs, and temporary files.
