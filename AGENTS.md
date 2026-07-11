# Marketing Ops Agent Guidance

- This is a private local personal plugin. Never copy credentials, Keychain values, Cookies, storage state, or browser Profiles into the public Algorithm Visualizer repository.
- Use pnpm. Keep the MCP transport local STDIO-only.
- Add or change behavior with red-green tests. Security modules require 100% line, branch, function, and statement coverage.
- Expose only the seven approved high-level MCP tools. Never add browser eval, arbitrary selectors, shell commands, file paths, secret export, or generic HTTP proxy tools.
- Setup may use hidden TTY input, official OAuth/device pages, GitHub CLI auth, or a headed persistent Profile. Main passwords are never accepted.
- T3-B has a fixed typed `gh api` client, read-only GitHub CLI/account/repository health checks, and a nonsecret local activation gate. Healthy authentication alone never enables the adapter; `marketing-ops setup github` must create the activation record, and every write rechecks health before registration. No real GitHub write smoke has been performed yet.
- The GitHub process runner must keep `shell: false`, a fixed executable and argument grammar, bounded output/time, and a safe environment allowlist. Never add arbitrary endpoints/arguments, token environment inheritance, `--show-token`, `--include`, or request bodies in argv.
- `publish_campaign` packages must come from the public Algorithm Visualizer renderer. Do not duplicate platform copy/UTM rendering in this plugin.
- `all-or-none` requires an explicit channel set and a complete one-to-one package set. Reject unverifiable `all-authorized` calls before adapter preflight.
- A media type is not an uploaded asset. Reject unresolved media until a validated asset-reference contract exists.
