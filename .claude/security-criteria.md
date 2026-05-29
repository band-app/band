# Security Criteria

The source of truth for what a Band PR review checks on **security concerns** — secrets handling, injection, auth scope, GitHub Actions, dependency risk, crypto. Each criterion has a stable ID (`SEC-N`) — cite the ID when you flag a violation.

This file is loaded by:

- `.claude/agents/security-reviewer.md` (the security specialist that applies these rules)
- `.claude/skills/review-changes/SKILL.md` (the orchestrator that dispatches the security-reviewer)
- `.github/workflows/claude-review.yml` (CI)

Output format and severity vocabulary are defined inline in `.claude/agents/security-reviewer.md`. Don't restate them here.

## 1. Secrets and credentials

- **SEC-1** *(blocker)* — **No secrets in source code, commits, or logs.** Hardcoded tokens, API keys, signing keys, database passwords, or any credential string is a blocker. Includes obvious patterns (`sk-...`, `ghp_...`, `xoxb-...`, `AKIA...`, 32+ char hex labelled as a key) and less obvious ones (a value committed to anything that isn't `.env.example` or a deliberate fixture). Log statements that print a value matching any of these patterns are also a blocker.
- **SEC-2** *(nit)* — **Log redaction.** Auth tokens, session cookies, PII (emails, names of authenticated users), and request bodies that may contain credentials must be redacted in log output. Use a redact helper, not raw `console.log(req)`.

## 2. Injection

- **SEC-3** *(blocker)* — **No SQL injection.** Database queries use parameterized inputs — Drizzle's typed API, prepared statements, or the `sql` tagged template where Drizzle handles binding. Raw SQL constructed by string concatenation with user input is a blocker.
- **SEC-4** *(blocker)* — **No command injection.** Subprocess calls (`execFile`, `spawn`, `exec`) must never pass user-controlled input as the command name or as shell-interpreted arguments. Use the array-form of `spawn`/`execFile`, never `exec` with a constructed command string. `shell: true` combined with user input is a blocker.
- **SEC-5** *(blocker)* — **No path traversal.** Filesystem operations whose path includes user input must reject `..` segments, resolve through `path.resolve` against a known base, and verify the result starts with that base. Symlinks pointing outside the base must be detected (`fs.realpath` + prefix check).
- **SEC-6** *(blocker)* — **No unsafe deserialization.** `YAML.load` (use `YAML.parse` from `yaml@2.x` or `safeLoad` from `js-yaml`), `eval`, `new Function(...)`, `vm.runInNewContext` on untrusted input are blockers. `JSON.parse` is safe at the byte level but the result must pass Zod (or equivalent schema) validation before reaching business logic.

## 3. Input validation and auth

- **SEC-7** *(blocker)* — **All client input validated at the boundary.** New tRPC procedures and HTTP routes use a Zod schema (or equivalent) on input. Passing `req.body` / `input` directly to business logic without validation is a blocker. (Overlaps `CODE-6`; flag from whichever side fits the violation better.)
- **SEC-8** *(blocker)* — **No silent auth/permission scope broadening.** Removing auth middleware, relaxing a permission check, expanding token scopes, or granting capabilities to existing roles is a blocker unless the PR description justifies it. If a token's scope changes, the existing token population must be invalidated or rotated as part of the same change.
- **SEC-9** *(nit)* — **Authorization is request-time, not module-load.** Auth checks that read a config at module load (so a redeploy is required to revoke) should be moved to request-time reads — same pattern as `TEST-30` for upstream URLs.

## 4. GitHub Actions and CI

- **SEC-10** *(blocker)* — **No untrusted `pull_request_target`.** Workflows must not check out the PR's `head` ref under the `pull_request_target` event with secrets exposed; that combination grants PR-controlled code access to write tokens and CI secrets. Use `pull_request` for PR-driven checks, or `actions/checkout` with `ref` pinned to the merge commit and secrets gated by environment-protection rules.
- **SEC-11** *(blocker)* — **No `${{ secrets.* }}` next to PR-controlled inputs.** Workflow `if:` conditions, step `run:` blocks, or environment variables that interpolate secrets near `${{ github.event.pull_request.* }}` or other PR-controlled fields leak secrets via log echo on a malicious payload.

## 5. Dependencies

- **SEC-12** *(nit)* — **Dependency additions are vetted.** New entries in `package.json` / `Cargo.toml` / lockfiles should be packages with a known publisher, reasonable activity, and not a typosquat of an existing dependency. Flag unfamiliar additions for human review with a one-line note ("verify this is the right `react-foo`, not the typosquat").
- **SEC-13** *(suggestion)* — **Lockfile churn.** A PR that updates 100+ transitive deps in one go should be flagged as a suggestion to split the dep update from the feature change.

## 6. Crypto and randomness

- **SEC-14** *(blocker)* — **Cryptographic randomness only.** Tokens, session IDs, nonces, and any other security-relevant random value use `crypto.randomBytes` / `crypto.randomUUID`. `Math.random` for a security-relevant value is a blocker.
- **SEC-15** *(suggestion)* — **TLS verification on by default.** `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, and `--insecure`-style flags on outbound HTTP calls need a documented reason.
