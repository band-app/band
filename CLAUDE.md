# Band

IDE-agnostic agent orchestrator.

## Testing Strategy

This project uses **integration tests** as the primary testing approach. Do not write unit tests with mocked dependencies.

### Why Integration Tests

Unit tests with heavy mocking verify that your mocks work, not that your system works. Integration tests exercise the real system through its public interfaces — the same way a client or user would interact with it.

### Rules

- **Never modify production code to make a test pass.** No test-only branches, no exporting internals, no `NODE_ENV` checks in business logic.
- **Black-box testing only.** Test through public interfaces: HTTP endpoints, CLI commands, file system outputs.
- **Real infrastructure.** For databases use test containers, not mocks. For file-based state use temporary directories. Start real servers on random ports.
- **MSW for external boundaries.** Mock only what you don't own (third-party APIs) using MSW at the network layer.
- **Node.js built-in test runner.** Use `node:test` with `node:assert/strict`. Don't add test framework dependencies unless already present.

See `.claude/skills/integration-tests.md` for the full set of rules and examples.

### Exceptions

- `packages/coding-agent/tests/codex-adapter.test.ts` is an event-mapping unit test that mocks `@openai/codex-sdk` via a custom Node loader (`tests/register-mock-loader.mjs` + `tests/mocks/codex-sdk.mjs`). The Codex SDK communicates with a subprocess over stdin/stdout, so MSW does not apply, and exercising the real `codex` binary is impractical in CI. The test is allowed to remain as-is until the SDK exposes a network seam or a stub binary; do not extend this pattern to other adapters.

## Git Hooks & CI

This repo has a pre-push hook (`.husky/pre-push`) that runs linting, formatting, and clippy checks. **Never bypass git hooks** — do not use `--no-verify` on `git push` or `git commit`. If a hook fails, fix the underlying issue instead of skipping the check.

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

Run `band generate-skills --output-dir apps/cli/skills` to regenerate all six skills, then copy each `<name>/SKILL.md` to `~/.claude/skills/<name>/SKILL.md`.
