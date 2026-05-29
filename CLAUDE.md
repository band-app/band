# Band

IDE-agnostic agent orchestrator.

## Testing Strategy

This project uses **integration tests** as the primary testing approach. Do not write unit tests with mocked dependencies.

> **When writing, adding, or modifying tests — backend OR frontend — invoke the [`write-integration-test`](.claude/skills/write-integration-test/SKILL.md) skill FIRST.** It is the canonical reference for this repository: real-server boot, Express stubs for external services, no tRPC mocking, no `page.route()` on own routes, Page Object Model for Playwright, locator priority, the universal checklist, and worked examples for both layers. The rules below are the summary; the skill is the source of truth.

### Why Integration Tests

Unit tests with heavy mocking verify that your mocks work, not that your system works. Integration tests exercise the real system through its public interfaces — the same way a client or user would interact with it.

### Rules

- **Never modify production code to make a test pass.** No test-only branches, no exporting internals, no `NODE_ENV` checks in business logic.
- **Black-box testing only.** Test through public interfaces: HTTP endpoints, CLI commands, file system outputs, the rendered DOM (frontend).
- **Real infrastructure.** For databases use test containers, not mocks. For file-based state use temporary directories. Start real servers on random ports.
- **External-only stubs at the network boundary.** Mock only services your process calls *out* to (third-party APIs, agent binaries, GitHub, etc.) using an **Express stub on a random port + env-var override** read at request time. Do NOT use MSW (it misses subprocess-originated traffic, and the env-var indirection is what forces the production code into a testable shape). Do NOT use `page.route()` to intercept your own backend routes from a Playwright test. Do NOT add a tRPC mock layer.
- **Test framework: match the package.** `node:test` with `node:assert/strict` is the default for new code. The web app (`apps/web`) is the exception: it already standardised on **vitest** before this convention was written down (the existing test suite uses `describe`/`it`/`expect`/`beforeAll` from `vitest`), so new tests under `apps/web/tests/` should use vitest too rather than mix runners in one package. Don't add test framework dependencies elsewhere unless already present.

See the `write-integration-test` skill (`.claude/skills/write-integration-test/SKILL.md`) for the full doctrine — backend + frontend integration tests, Express-stub patterns, page-object conventions, the universal checklist, and worked examples.

### Frontend tests (web app)

**Frontend tests follow the same integration doctrine as backend tests** — they boot the real server (the production `dist/start-server.mjs` bundle), drive it through a real Chromium via Playwright, and assert on the real rendered DOM / `localStorage` / URL state. Read [`docs/integration-testing.md`](docs/integration-testing.md) and the `write-integration-test` skill (`.claude/skills/write-integration-test/`) before authoring frontend tests.

The non-negotiables for any new frontend test:

- **Boot the real server** with `apps/web/e2e/helpers/server.ts` (`startServer` + `createTmpHome` + `seedState` + `seedSettings`). No in-process React mounting. No shallow renders. No `jsdom` + `renderHook` for behaviour that's user-observable.
- **No tRPC mocking.** No `createTrpcMock`. No `page.route('**/trpc/**', …)`. The existing `apps/web/e2e/helpers/trpc-mock.ts` and the two `workspace-switch-*.spec.ts` files that use it are technical debt to be migrated, not a pattern to copy.
- **Page Object Model.** Locators (`getByRole`, `getByTestId`) live on a page object class under `apps/web/e2e/pages/`. The test body never calls `page.goto()`, `page.getByRole()`, `page.getByTestId()` directly — only methods like `workspacePage.maximizePanel()`.
- **Locator priority for elements your code owns:** `getByRole({ name })` when the ARIA name is system-controlled; otherwise `getByTestId("page__element")` (BEM convention). Banned: CSS selectors, element IDs, `getByText` for localisable copy.
- **External services get Express stubs** under `apps/web/e2e/fixtures/` (or `apps/web/tests/fixtures/` if shared with backend tests). One stub per env var. Subprocess-originated traffic (`codex`, `claude-code`, `git`) is exactly the case where MSW would silently fail — Express stubs cover it.
- **Production code reads outbound URLs from env vars at request time**, not at module load (`axios.create({ baseURL })` at module top is wrong). Refactoring that pattern is the only allowed production-code change a test may introduce, alongside `data-testid` attributes on JSX.
- **Wait properly.** `expect(locator).toBeVisible()` and `expect.poll(() => …)` auto-retry. Never `page.waitForTimeout(N)`.

Look at `apps/web/e2e/workspace-maximize-state.spec.ts` and `apps/web/e2e/pages/WorkspacePage.ts` as the model — they follow the doctrine end-to-end. Run frontend tests with `pnpm --filter @band-app/server test:e2e`.

### Exceptions

- `packages/coding-agent/tests/codex-adapter.test.ts` is an event-mapping unit test that mocks `@openai/codex-sdk` via a custom Node loader (`tests/register-mock-loader.mjs` + `tests/mocks/codex-sdk.mjs`). The Codex SDK communicates with a subprocess over stdin/stdout, so MSW does not apply, and exercising the real `codex` binary is impractical in CI. The test is allowed to remain as-is until the SDK exposes a network seam or a stub binary; do not extend this pattern to other adapters.

## Git Hooks & CI

This repo has a pre-push hook (`.husky/pre-push`) that runs linting, formatting, and clippy checks. **Never bypass git hooks** — do not use `--no-verify` on `git push` or `git commit`. If a hook fails, fix the underlying issue instead of skipping the check.

**Always run `/review-and-apply` before pushing code.** This invokes the `review-and-apply` skill, which runs Band's CI-style PR review locally against the current branch, auto-applies the resulting fixes, and verifies them with lint/clippy/tests. Do the local review *before* `git push` so the same criteria CI uses catch issues while they're still cheap to fix.

## Project Tracking

All issues are created in the `band-app/band` GitHub repo.

## Architecture: Web Server vs Desktop App

The web server (`apps/web`) handles **data, state, and background processes** only. It must never invoke macOS-only shell helpers (folder pickers, Finder reveal, opening apps, installing the CLI symlink with administrator privileges). Those bridges live in the Electron desktop app (`apps/desktop/src/main/ipc/macos-shell.ts`) and are invoked from the React webview via the IPC bridge in `apps/web/src/lib/desktop-ipc.ts`, which talks to the preload script at `apps/desktop/src/preload/index.cts`.

## Band CLI Skills

The Band CLI ships **six domain-specific skills**, each generated from its own template in `apps/cli/skills/` plus the CLI schema:

- `band.md` → `band/SKILL.md` — workspaces, projects, cronjobs, tunnel, settings, schema, notify, generate-skills.
- `band-chat.md` → `band-chat/SKILL.md` — chat panes (`band chats ...`).
- `band-terminal.md` → `band-terminal/SKILL.md` — terminal sessions (`band terminals ...`).
- `band-browser.md` → `band-browser/SKILL.md` — browser tabs (`band browsers ...`).
- `band-start.md` → `band-start/SKILL.md` — kickoff flow: create a workspace and submit the first agent task (`band workspaces create --prompt ...`) with Jira/GitHub ticket auto-detection and branch-name generation.
- `band-loop.md` → `band-loop/SKILL.md` — schedule a recurring agent prompt against a workspace via `band cronjobs`, with an optional self-deleting "stop when criteria is met" wrapper. Native answer for users who would otherwise reach for Claude Code's `/loop`.

Reference-shaped templates (e.g. `band`, `band-chat`, `band-terminal`, `band-browser`) have a `commands:` frontmatter field listing comma-separated CLI command-name prefixes, plus a `<!-- COMMANDS -->` placeholder in the body; the generator filters the schema by those prefixes and splices the rendered Commands section into the placeholder. Workflow-shaped templates (e.g. `band-start`, `band-loop`) are self-contained recipes — they omit both `commands:` and the placeholder, and the generator emits the template body verbatim. The split improves trigger precision and keeps each generated SKILL.md scoped to one task type (issue #331).

### Installed skill layout (shared + symlinks)

Skills are installed once into a canonical, agent-agnostic location and then linked into each detected coding-agent's skills directory:

```
~/.agents/skills/<name>/SKILL.md          ← canonical content (one copy)
~/.claude/skills/<name>            → ~/.agents/skills/<name>     (symlink)
~/.codex/skills/<name>             → ~/.agents/skills/<name>     (symlink)
~/.gemini/skills/<name>            → ~/.agents/skills/<name>     (symlink)
~/.config/opencode/skills/<name>   → ~/.agents/skills/<name>     (symlink)
```

The symlinks are created with **absolute** targets (`symlinkSync(target, link, "dir")` in TS / `std::os::unix::fs::symlink` in Rust, both fed the canonical `~/.agents/skills/<name>` path). That keeps the link valid regardless of where it lives in the agent's directory tree, at the cost of breaking if the home directory ever moves — acceptable since each user only installs into their own `$HOME`.

Editing a `SKILL.md` in `~/.agents/skills/` is reflected in every linked agent without re-running the installer.

**Supported coding agents** (Band creates a symlink for each one whose config dir is present on the host):

| Agent type     | Detected via         | Skills dir                       |
| -------------- | -------------------- | -------------------------------- |
| `claude-code`  | `~/.claude/` exists  | `~/.claude/skills/`              |
| `codex`        | `~/.codex/` exists (`$CODEX_HOME` honored) | `~/.codex/skills/` |
| `gemini-cli`   | `~/.gemini/` exists  | `~/.gemini/skills/`              |
| `opencode`     | `~/.config/opencode/` exists | `~/.config/opencode/skills/` |

`cursor-cli` is deliberately excluded — Cursor has no documented user-scope skills directory.

The list of supported agents lives in `packages/coding-agent/src/install-skills.ts::SUPPORTED_AGENT_TYPES` (a single place to update when a new agent adds skills support). The sync logic lives in `apps/web/src/lib/cli-skills.ts::installSkills` and runs on every server boot from `runFirstTimeSetup` — idempotent: an existing symlink pointing at the right shared dir is left alone, an existing symlink pointing elsewhere (or a real directory occupying the path) is reported as a conflict rather than overwritten.

### Manual regeneration & install

- `band generate-skills --output-dir apps/cli/skills` — regenerate the six in-repo skill templates from the live CLI schema (used in development to keep the source-controlled SKILL.md files current).
- `band skills install` — render the templates against the current schema and install them into `~/.agents/skills/`, then symlink each detected coding agent's skills directory. Idempotent. Useful for users running the CLI outside the Band dashboard, or for forcing a re-sync without rebooting the web server. The Band web server invokes the same install logic on every boot from `runFirstTimeSetup`, so most users never need to call it directly.

Optional flags on `band skills install`:

- `--home <path>` — override the destination home dir (mostly for tests).
- `--filter <substr>` — only install skills whose name contains the substring (e.g. `--filter chat`).
