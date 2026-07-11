# Marketing Ops Agent Guidance

- This is a private local personal plugin. Never copy credentials, Keychain values, Cookies, storage state, or browser Profiles into the public Algorithm Visualizer repository.
- Use pnpm. Keep the MCP transport local STDIO-only.
- Add or change behavior with red-green tests. Security modules require 100% line, branch, function, and statement coverage.
- Expose only the seven approved high-level MCP tools. Never add browser eval, arbitrary selectors, shell commands, file paths, secret export, or generic HTTP proxy tools.
- Setup may use hidden TTY input, official OAuth/device pages, GitHub CLI auth, or a headed persistent Profile. Main passwords are never accepted.
- T2 has no real platform adapters. All write tools must fail closed until a tested adapter is explicitly enabled.
