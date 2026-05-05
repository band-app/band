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

## Architecture: Web Server vs Tauri App

The web server (`apps/web`) handles **data, state, and background processes** only. It must never invoke macOS-only shell helpers (folder pickers, Finder reveal, opening apps, installing the CLI symlink with administrator privileges). Those bridges live in the Tauri desktop app (`apps/dashboard/src-tauri/src/commands/macos_shell.rs`) and are invoked from the React webview via `@tauri-apps/api`.

## Band CLI Skill

The Band CLI skill is generated from the template at `apps/cli/skills/band-cli.md` and the CLI schema. Run `band generate-skills --output-dir apps/cli/skills` to regenerate, then copy the output to `~/.claude/skills/band/SKILL.md`.
