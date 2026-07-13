# Security & Privacy Model

## What lodestone reads

### By default (no configuration required)
- **Transcripts**: Session JSONL files from your Claude Code directories (read-only, parsed for usage/context metrics)
- **Settings**: `.claude/settings.json` files (read-only, to detect existing hooks)
- **Project structure**: `.git` metadata (read-only, for branch/dirty state in handoffs)
- **Handoff files**: `.claude/handoff/latest.md` (read-only when rehydrating; written when creating)

### With `config set realUsage on` (opt-in)
- **OAuth access token**: Read from OS Keychain (macOS `security find-generic-password`) or `~/.claude-profiles/<profile>/.credentials.json` (Linux). **Read-only, local access only; never stored elsewhere.**

## What lodestone writes

- **Handoff files**: `.claude/handoff/latest.md` and archived versions (your project directory)
- **Config**: `~/.config/lodestone/config.json` (profiles registry, settings)
- **Logs**: `~/.config/lodestone/lodestone.log` (command history, errors; size-capped, rotated; no sensitive data)
- **Usage cache**: `~/.config/lodestone/usage-cache.json` (quota % and reset times from statusline; no tokens or credentials)
- **Hook state**: Advisor debounce tracker in `<configDir>/lodestone/` (one-per-5%-step per session)
- **Keepalive schedule**: PID file in `~/.config/lodestone/keepalive/` (process bookkeeping, no credentials)

## What lodestone never does

- ❌ Store, copy, or migrate OAuth tokens
- ❌ Transmit credentials anywhere except `api.anthropic.com` over TLS
- ❌ Read or write Keychain items (other than the one access token lookup)
- ❌ Delete profile directories (respects ownership; `removeProfile` only unregisters from config)
- ❌ Make unsolicited network calls (HTTP only to `api.anthropic.com` via `api.anthropic.com/api/oauth/usage`, behind opt-in flag, cached)
- ❌ Collect telemetry or analytics
- ❌ Depend on any external npm packages at runtime (zero-deps guarantee; auditable)

## OAuth endpoint usage (opt-in)

The `config set realUsage on` option reads your own OAuth access token and queries `api.anthropic.com/api/oauth/usage` to fetch real quota percentages for cross-profile views (when one account doesn't have a live session). This is used by Claude Code itself and community tools.

**Explicit guardrails:**
- Token is read only from local storage (Keychain or credentials.json) you control
- Endpoint is `api.anthropic.com/api/oauth/usage` only — no other hosts
- Responses are cached ≥180 seconds with file locking (minimize polling)
- Failures gracefully degrade to JSONL estimation (never required)
- No retry-storm on 429; max one retry then stop
- `User-Agent: claude-code/<version>` required (community convention, avoids aggressive rate-limiting)

**Risk:** This endpoint is undocumented (like community tools use) — Anthropic may change or deprecate it. If it breaks, the feature degrades to estimates; the CLI keeps working.

## Threat model: what could go wrong

| Threat | Likelihood | Mitigation |
|---|---|---|
| Malicious npm dependency | Low (zero runtime deps) | Auditable package.json; no transitive risk |
| Keychain compromise | Low (OS-level) | Only reads token we don't store elsewhere; revoke in Claude Code settings if breached |
| Credentials.json exposure | Medium (file in ~/.claude-profiles) | File permissions: user-only (0600 on Linux); not our responsibility but document best practices |
| OAuth endpoint becomes malicious | Very low | Only HTTPS, only to anthropic.com; session-level token revokable |
| Transcript files on disk | Low | Transcripts are your own files; we read, never copy/transmit; standard file permissions apply |
| Hook code path complexity | Medium | Tested; hooks always exit 0, failures logged not printed (safe to run unattended) |
| Undocumented API change | Medium | Graceful degradation (estimates fallback); feature flag (`realUsage`) isolates risk |

## Reporting security issues

Please report security vulnerabilities responsibly:

1. **Do not** open a public GitHub issue
2. Email security details to: [maintainer email — to be filled on publish]
3. Include: affected version, reproduction steps, impact
4. Allow 30 days for a patch before public disclosure

We will acknowledge receipt within 48 hours and commit to a patch timeline.

## Audit & transparency

- **Package contents**: `npm pack --dry-run` lists exactly what ships. No build-time injection or hidden files.
- **Dependencies**: `npm ls --production` confirms zero runtime dependencies
- **Code review**: All source in `src/` is auditable TypeScript → JavaScript. No obfuscation, no bundling.
- **Logs**: Plain text in `~/.config/lodestone/lodestone.log`, readable by the user

## Privacy by default

- Transcripts stay local (never uploaded)
- Credentials never copied or transmitted (read-only, local use only)
- Handoff files live in your project's `.claude/handoff/` (your ownership, version control)
- No analytics, no phoning home
- No build-time telemetry

Opt-in OAuth is the only place where a network call happens, and it's explicit, cached, and degradable.

## Scope & limitations

- This tool cannot and does not attempt to protect against: malicious Claude Code plugins, local machine compromise, stolen Keychain passwords, leaked oauth tokens, or deliberate ToS violation
- Nor does it attempt to enforce any Anthropic policies — that's between you and Anthropic
- It's a measurement and routing tool for your own accounts on your own machine

## Updates & security patches

Subscribe to GitHub releases (or `npm` deprecation notices) to stay informed. Security patches will be back-ported if necessary.
