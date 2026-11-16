---
paths:
  - "**/AccountUsagePopover.tsx"
  - "**/claude-usage.ts"
  - "**/codex-usage.ts"
  - "**/fixtures/usage-stub.ts"
  - "apps/hub/src/server/services/account-usage-service.ts"
  - "apps/hub/tests/account-usage.test.ts"
  - "apps/web/e2e/account-usage.spec.ts"
  - "packages/host-local/src/usage/**"
  - "packages/host-local/tests/account-usage-mapping.test.ts"
  - "packages/host-local/tests/claude-usage-login.test.ts"
---

# Architecture: account usage

The footer's usage popover (`AccountUsagePopover.tsx`) shows the Claude and Codex limits of every account logged in on an online worker. Each worker reads its own logins, so no token leaves it.

- Readers (`packages/host-local/src/usage/`): `claude-usage.ts` takes the token from `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json` when its `expiresAt` has not passed, else on macOS from the Keychain item `Claude Code-credentials` (this can prompt; the Mac's live login is refreshed there while the file can lag), and calls `api.anthropic.com/api/oauth/usage`. `codex-usage.ts` takes `tokens.access_token` from `$CODEX_HOME/auth.json` and calls `chatgpt.com/backend-api/wham/usage`. The identity is the email from `~/.claude.json` or the Codex `id_token`, the plan comes from the credentials or the response. When every login found has an `expiresAt` in the past, no request is sent and the status is `idle` ("No recent Claude session on contabo"): the refresh token is fine, but only a running Claude Code refreshes the access token, and Band never refreshes or writes credentials (a refresh rotates the refresh token and can log Claude Code out). `expired` stays for a token the API refuses (401/403) that had not aged out. Credentials without `expiresAt` count as valid. An older hub shown `idle` falls back to the `error` wording in `MESSAGES`; a hub that lacks that fallback prints the status as an unknown reason but does not crash. `BAND_CLAUDE_USAGE_URL`, `BAND_CODEX_USAGE_URL` and `BAND_USAGE_KEYCHAIN=off` are read on every call and let tests point at a stub. A worker caches an answer for 3 minutes (30 s for no login, 1 minute for an error, 5 minutes after a 429) and shares one request between concurrent calls.
- `Host.agentEnv.accountUsage({ refresh })` returns one `AccountUsage` per provider and never rejects. The worker method is `agentEnv.accountUsage` (passive for the idle clock).
- Hub: `accountUsage.list { refresh? }` (`services/account-usage-service.ts`) asks every online worker, merges rows of the same account (case-insensitive email) into one that names its workers, and groups failures into `problems` ("Not logged in on contabo"). The MCP endpoint and the relay leave it out.
- Tests: `packages/host-local/tests/account-usage-mapping.test.ts`, `packages/host-local/tests/claude-usage-login.test.ts` (login choice, fake `security` on PATH), `apps/hub/tests/account-usage.test.ts` (real hub and four workers, `fixtures/usage-stub.ts`), `apps/web/e2e/account-usage.spec.ts`. Not done yet: `band usage`, other providers.
