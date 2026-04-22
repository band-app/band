# Band

IDE-agnostic agent orchestrator — dashboard + VS Code extension.

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

## Project Tracking

All issues are created in the `band-app/band` GitHub repo.

## Architecture: Web Server vs Tauri App

The web server (`apps/web`) handles **data, state, and background processes** only. It must never do window management — no spawning `code`, no AppleScript, no opening/focusing/positioning IDE windows. Window management (VS Code focus, window positioning, folder pickers, Finder reveal) is the Tauri desktop app's responsibility (`apps/dashboard`).

## Band CLI Skill

The Band CLI skill is maintained at `apps/cli/SKILL.md`. When updating the skill, edit that file and copy it to `~/.claude/skills/band/SKILL.md`.
