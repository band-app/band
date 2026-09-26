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
- **Coding agents are stubbed at the ACP boundary.** Chats talk to agents over the Agent Client Protocol; tests set `BAND_TEST_ACP_AGENT` to the scripted stub agent `apps/web/tests/fixtures/acp-stub-agent.mjs` (scenario, capabilities and request log are env-configured — see its header and `apps/web/tests/helpers/acp-chat.ts`). Don't mock the ACP SDK or the agent-session service.
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

- `apps/web/tests/branch-status-poller-ci-throttle.test.ts` drives the exported `getBatchedCIStatuses` directly instead of booting the full server. It covers an internal, non-user-observable throttle: the CI poller must log a persistent `gh` GraphQL failure only once per host until it recovers, rather than every ~5–60 s tick. The throttle state has no HTTP/DB projection to assert against, and a hermetic `gh` *success* (needed to observe the recovery reset) would require network + auth, so a full real-server test is impractical. Instead the test exercises the real batching function through its public surface with real `git` + real (offline-failing) `gh` subprocesses — the same direct-function style as `git.test.ts` — which is why `getBatchedCIStatuses` is exported. This is the allowed alternative to a mocked-out fake; do not add a tRPC/`console` mock layer or a `NODE_ENV` test branch to the poller.

- `apps/web/tests/terminal-pool-nudge-resize.test.ts` drives `TerminalPool.nudgeResize` directly (real PTY in a temp dir, no mocks). The nudge is the shrink-and-restore SIGWINCH pair fired after a reconnect replay so a live TUI repaints; its only hermetic observable is the PTY dims themselves — asserting the resulting repaint over the `/terminal` WS would require a SIGWINCH-aware TUI binary in CI. The serialized-replay payload (the user-observable half of that feature) is covered at the WS layer in `terminal-ws.test.ts`.

- `apps/web/tests/terminal-pool-spawn-dedup.test.ts` drives `TerminalPool.spawn` directly (real PTY in a temp dir, no mocks) instead of booting the full server. It guards the spawn-dedup fix (issue #617): a terminal is created via two concurrent paths — the WebSocket handler's spawn-on-`getSession`-miss and the tRPC `terminal.create` mutation — and without dedup both spawned competing PTYs, so the client attached to one while the server's session map / scrollback pointed at the other. That double-spawn is a genuine nondeterministic race that can't be forced reliably through the full WS + tRPC stack, so the test asserts the pool-level invariant (concurrent + repeated spawns of one terminalId share a single PTY) through the pool's public surface — the same direct-function style as `git.test.ts`. Do not weaken it into a mocked test.

- `apps/web/tests/terminal-daemon-build-mismatch.test.ts` sets up its scenario through `startDaemonOfBuild` (`tests/helpers/terminal-daemon.ts`), which starts a daemon with another `--build-id` (or from an entry file it then deletes) and puts a shell on it over the daemon's socket protocol, using `launchDaemon` and `DaemonClient` directly. No server of the current build will ever start a shell on such a daemon (issue #652), so there is no server path to create that state. Every assertion still goes through the real server: tRPC, the `/terminal` WebSocket, and the process table.

- `apps/web/tests/browser-guest-retention.test.ts` drives `registerBrowserGuest` + `activateBrowserGuestWorkspace` (`apps/web/src/lib/browser-guest-retention.ts`) directly, with no mocks. It covers the hidden-workspace browser guest budget: at most 4 hidden workspaces keep live `<webview>` guests, least recently activated evicted first, the active workspace never evicted. The only consumer, `BrowserPaneComponent`, mounts `<webview>` elements only on the desktop build (`isDesktop`), and the e2e harness boots the web build in plain Chromium, which has no `<webview>`, so a real-server Playwright test cannot observe it. What stays untested is the glue in `BrowserPaneComponent` (register while its `<webview>` exists, remove the element on evict, recreate it at the last URL when the workspace is shown). For the same reason (no Electron, so no `<webview>`, in e2e) the rest of the desktop browser wiring has no automated test either: the `will-attach-webview` handler in `apps/desktop/src/main/webview-security.ts` (its admit/harden rules are pure functions in `browser/guest-policy.ts`, covered by `apps/desktop/tests/guest-policy.test.ts`), the guest navigation guard and session `file:` block in `browser/guest-manager.ts`, page popups opening a Band tab (`WorkspaceCenterDockview`), and `apps/web/src/lib/browser-webview-dom-bridge.ts`. Verify changes there against a real desktop build.

- `apps/desktop/tests/chrome-import.test.ts` drives `listChromeProfiles` and `readChromeCookies` (`apps/desktop/src/browser/chrome-import/`) directly, against a real temp Chrome user-data dir with a `Local State` file and a SQLite cookie DB encrypted the way Chrome encrypts on macOS. The Keychain lookup is replaced by passing a known password, because the real one is an interactive macOS dialog. The e2e harness boots the web build, where browser panes don't render, and Electron's `session.cookies` needs the Electron runtime, so these stay untested: the consent dialog (`ChromeImportDialog.tsx`), the pane's profile menu, choosing the `<webview>` partition per tab (`BrowserPanel.tsx`, `profiles.ts`, the offscreen pages in `guest-manager.ts`), and writing cookies into the session (`chrome-import/import.ts`). The server side (profiles, project defaults, the CDP block) is covered through the real server in `apps/web/tests/browser-profiles.test.ts` and `apps/web/e2e/settings-browser-profiles.spec.ts`.

- `apps/desktop/tests/updater.test.ts` covers the auto-update flow through `UpdateController` (`apps/desktop/src/main/updater.ts`), with a fake in place of the `electron-updater` singleton, which cannot load outside Electron. It asserts the statuses the controller broadcasts: silent background checks, the checking, up-to-date and error steps of a menu check, download progress, restart, dismissal, overlapping checks and scheduling. The renderer's `UpdateToast` and `use-app-update.ts`, and the `updater_*` IPC handlers and preload allowlist entries, stay untested: the toast renders only when `window.__BAND_DESKTOP__` exists, and the e2e harness boots the web build without Electron (the same gap `resources.spec.ts` records for `ElectronCard`).

## Git Hooks & CI

This repo has a pre-push hook (`.husky/pre-push`) that runs linting, formatting, and clippy checks. **Never bypass git hooks** — do not use `--no-verify` on `git push` or `git commit`. If a hook fails, fix the underlying issue instead of skipping the check.

**Always run `/review-and-apply` before pushing code.** This invokes the `review-and-apply` skill, which runs Band's CI-style PR review locally against the current branch, auto-applies the resulting fixes, and verifies them with lint/clippy/tests. Do the local review *before* `git push` so the same criteria CI uses catch issues while they're still cheap to fix.

## Project Tracking

All issues are created in the `band-app/band` GitHub repo.

## Architecture: Web Server vs Desktop App

The web server (`apps/web`) handles **data, state, and background processes** only. It must never invoke macOS-only shell helpers (folder pickers, Finder reveal, opening apps, installing the CLI symlink with administrator privileges). Those bridges live in the Electron desktop app (`apps/desktop/src/main/ipc/macos-shell.ts`) and are invoked from the React webview via the IPC bridge in `apps/web/src/lib/desktop-ipc.ts`, which talks to the preload script at `apps/desktop/src/preload/index.cts`.

## Architecture: browser profiles

A browser profile is a separate cookie jar for browser-pane tabs: one Electron session partition per profile (`persist:band-browser-profile-<id>`, see `apps/desktop/src/browser/profiles.ts`). The built-in Default profile is `null` everywhere and keeps the original `persist:band-browser` partition.

- The web server stores only metadata: the `browser_profiles` table, each project's default profile (`project_browser_profiles`), and each tab's `profileId` in its `panel_states` blob. `browsers.create` without a `profileId` uses the project default. `browsers.setProfile` switches a tab and makes that profile the project default.
- Chrome import runs entirely in the desktop app (`apps/desktop/src/browser/chrome-import/`): it reads Chrome's `Local State` and a snapshot of the profile's cookie DB, gets the "Chrome Safe Storage" key through `security find-generic-password` (the macOS Keychain prompt), decrypts, and writes the cookies into the new profile's partition. Cookie values never cross IPC, reach the web server, or get logged. The renderer asks for consent before any Chrome data is read (`ChromeImportDialog.tsx`).
- A pane's `<webview>` sets its `partition` from the tab's profile (`partitionForProfile` in `apps/web/src/lib/browser-webview.ts`, mirrored in `apps/desktop/src/browser/profiles.ts`). `guest-policy.ts` admits only the Default and profile partitions, and the guest manager prepares each session (`band-action://` handler, no `file:`) when its first guest attaches.

## Architecture: Web Server vs Terminal Daemon

Terminal PTYs do not live in the web server. They live in the **terminal daemon** (`apps/web/terminal-daemon.ts`, bundled to `dist/terminal-daemon.mjs`), a detached process the server launches on the first terminal spawn, so shells survive a server restart (desktop relaunch, auto-update, `pnpm dev` reload, crash). The restarted server reattaches to the same shells, and the browser replays their screens over the unchanged `/terminal` WebSocket.

- `TerminalService` talks to a `TerminalBackend` (`src/server/infra/terminals/terminal-backend.ts`). `DaemonTerminalBackend` is the default. `InProcessTerminalBackend` is used on Windows, when `BAND_TERMINAL_DAEMON=0`, and as a fallback when the daemon cannot start; its terminals die with the server. Nothing outside `infra/terminals/` touches node-pty.
- The daemon knows nothing about workspaces, layouts or events. It runs a `TerminalPool` behind a Unix socket (NDJSON, token hello, separate control and stream connections). The wire protocol is in `src/server/infra/terminals/daemon/protocol.ts`; bump `PROTOCOL_VERSION` on any change to it.
- Runtime files live in `~/.band/run/` (mode 0700): `terminal-daemon-v1.sock`, `.token`, `.pid`, and `terminal-daemon.log`. If the socket path would exceed the 104-byte `sun_path` limit, the socket moves to `/tmp/band-<uid>/`, named by a hash of the run dir.
- Socket publishing follows orca's endpoint-ownership rules (see the header of `daemon/endpoint.ts`): never unlink a socket you did not create, only a refused or missing connect proves a daemon dead, and a daemon never removes its endpoint on shutdown.
- Server shutdown only disconnects. A session ends when its tab is closed, its workspace is deleted (or found deleted at boot), or its shell exits.
- The daemon exits on its own, following orca's daemon: when it has no shells, no spawn in flight and no connection, the moment its last server disconnects (or 2 minutes after launch if none ever connects). If its socket is replaced or removed, it drains: no new sessions, existing shells keep working over already-open connections, and it exits when the last one ends. If `~/.band/run` disappears, it kills its shells and exits.
- New sessions only start on a daemon of the server's own build (issue #652). The build ID is the size and mtime of the daemon entry file. When the endpoint is served by a daemon of another build, or by one whose entry file (recorded in its pid file) no longer exists, the server's first spawn launches a daemon of its own build with `--supersede <dev>:<ino>`. That daemon hardlinks the old socket to a private retired name (`.r<tag>` beside the socket, plus `terminal-daemon-v1.retired-<tag>.token` and `.pid` in the run dir), then renames itself over the endpoint. The old daemon sees its endpoint lost and drains. Servers keep reattaching its shells, including after a restart, through the retired name. It exits when its last shell ends, and the daemon that created the retired names removes them then. A daemon stays alive while it holds retired names.
- Tests: the server helpers' `close()` stops the home's daemon (`tests/helpers/terminal-daemon.ts`), because it is detached and escapes the process-group kill. Pass `{ keepTerminalDaemon: true }`, or use the e2e fixture's `restart()`, to model a restart.

## Band CLI Skills

The Band CLI ships **six domain-specific skills**, each authored directly as `apps/cli/skills/<name>/SKILL.md` — that file is the single source of truth and is baked into the Rust binary via `include_str!`:

- `band/SKILL.md` — workspaces, projects, cronjobs, tunnel, settings, schema, notify, skills install.
- `band-chat/SKILL.md` — chat panes (`band chats ...`).
- `band-terminal/SKILL.md` — terminal sessions (`band terminals ...`).
- `band-browser/SKILL.md` — browser tabs (`band browsers ...`).
- `band-start/SKILL.md` — kickoff flow: create a workspace and submit the first agent task (`band workspaces create --prompt ...`) with Jira/GitHub ticket auto-detection and branch-name generation.
- `band-loop/SKILL.md` — schedule a recurring agent prompt against a workspace via `band cronjobs`, with an optional self-deleting "stop when criteria is met" wrapper. Native answer for users who would otherwise reach for Claude Code's `/loop`.

Each `SKILL.md` is self-contained: the per-skill `## Commands` reference is written out in the file itself, not rendered from the CLI schema. (Earlier these were generated from the live schema by a `band generate-skills` command via a `<!-- COMMANDS -->` placeholder + `commands:` frontmatter; that command and the whole rendering pipeline were removed in favour of authoring the files directly — issue #331.) The split into one skill per task type improves trigger precision and keeps each SKILL.md scoped to one domain. When you change the CLI surface, update the affected skill's `## Commands` section by hand so it stays accurate.

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

The list of supported agents lives in `packages/coding-agent/src/install-skills.ts::SUPPORTED_AGENT_TYPES` (a single place to update when a new agent adds skills support). The write/symlink logic lives in the Rust CLI (`apps/cli/src/skills.rs::install_skills`); the web server's `apps/web/src/server/services/cli-skills-service.ts::installSkills` shells out to `band skills install` on every boot from `runFirstTimeSetup`. It's idempotent: an existing symlink pointing at the right shared dir is left alone, an existing symlink pointing elsewhere (or a real directory occupying the path) is reported as a conflict rather than overwritten.

### Install

- `band skills install` — write the six embedded SKILL.md files into `~/.agents/skills/`, then symlink each detected coding agent's skills directory. Idempotent. Useful for users running the CLI outside the Band dashboard, or for forcing a re-sync without rebooting the web server. The Band web server invokes this same subcommand on every boot from `runFirstTimeSetup`, so most users never need to call it directly.

To change a skill's content, edit `apps/cli/skills/<name>/SKILL.md` directly and rebuild the CLI — there is no generation step.

Optional flags on `band skills install`:

- `--home <path>` — override the destination home dir (mostly for tests).
- `--filter <substr>` — only install skills whose name contains the substring (e.g. `--filter chat`).
