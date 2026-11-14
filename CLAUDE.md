# Band

IDE-agnostic agent orchestrator.

## Terms

- A **repo** is one registered repository (or plain folder). `repos.*` in tRPC, `band repos` in the CLI, the `repos` table.
- A **worktree** is one working copy of a repo that an agent works in, identified by `<repo>-<branch>`. `worktrees.*` in tRPC, `band worktrees` in the CLI, `BAND_WORKTREE_ID` in an agent's environment. It is a git worktree for a git repo. The one exception is a plain (non-git) repo's single folder, which keeps the name without being a git worktree. See `docs/glossary.md`.
- A **worker** is a computer connected to the hub that runs worktrees and agents. The hub's own machine is the built-in worker `local`. In code a worker is a `Host` (`Host`, `HostRegistry`, `hostId`, the `hosts` table, `packages/host-*`, `@h-` ids), and users read "worker". The tRPC router is `workers.*` with `hosts.*` kept as an alias, and the CLI is `band workers` with `band hosts` hidden. The old names still work where they were read before: the hub reads `BAND_LOCAL_HOST` and `BAND_DEFAULT_HOST`, a runner hook's `BAND_HOST_REPO_PATH` line is parsed, the provisioning script exports `BAND_HOST_LABELS` beside the new name, runner hooks get `BAND_HOST_ID` beside `BAND_WORKER_ID`, and `band notify` reads `BAND_HOST_ID`. The `band-worker` binary reads only `BAND_WORKER_*`. The `BAND_WORKER_*` names win. See `docs/glossary.md` (Renamed names and their aliases).
- A project was the cross-repo unit (a context repo, a project folder and a coordinator). It was removed in favour of origin links (plan section 15, `docs/glossary.md`). Third-party meanings of the word remain: Claude's `~/.claude/projects` directory, tsserver and Playwright projects.
- `tasks.*` in tRPC is the queue of agent turns. There are no task folders.
- `.band/config.json` keeps its `workspace` key (`workspace.copyFiles`, `workspace.defaultVia`, `workspace.terminal`), because file formats in a user's repo are not renamed.

## Testing Strategy

This repo uses **integration tests** as the primary testing approach. Do not write unit tests with mocked dependencies.

> **When writing, adding, or modifying tests — backend OR frontend — invoke the [`write-integration-test`](.claude/skills/write-integration-test/SKILL.md) skill FIRST.** It is the canonical reference for this repository: real-server boot, Express stubs for external services, no tRPC mocking, no `page.route()` on own routes, Page Object Model for Playwright, locator priority, the universal checklist, and worked examples for both layers. The rules below are the summary; the skill is the source of truth.

Rules TEST-36 to TEST-45 in `.claude/testing-criteria.md` cover flaky-test patterns (waiting for the wrong thing, `.first()` on multi-instance kinds, bare timeouts, leaking work between tests). Read them before writing or fixing a test.

CI retries a failed test once, only when `CI` is set (Playwright `retries: 1`, vitest `retry: 1` in the hub and web configs). A test that passes on the retry does not fail the job and is reported as flaky: the `flaky-report` job in `ci.yml` prints it in the run summary and, on `merge_group` and `push`, files or updates one issue per test (`flaky: <file> › <test name>`, label `flaky`, one line per run) through `scripts/ci/report-flaky.mjs`. The producers are Playwright's JSON reporter and `scripts/ci/vitest-flaky-reporter.mjs`, both writing under `BAND_FLAKY_DIR`. A test that fails both attempts fails the job. The node:test suites (`packages/*`, `apps/worker`) have no retry. Local runs and `pnpm flake-guard` never retry.

Quarantine: a test that flaked 3 or more times in 7 days goes on `.github/flaky-quarantine.txt` (`<file> › <describe> › <test>  # <issue>`). `BAND_FLAKY_QUARANTINE` (`exclude` by default in CI, `only`, or `off` by default locally) makes the hub, web unit and web e2e configs skip the listed tests; the `test-quarantine` job sets `only` and has `continue-on-error`, and nothing waits for it. The fix PR removes the line. `scripts/ci/tests/report-flaky.test.mjs` (`node --test scripts/ci/tests/*.test.mjs`) tests the report and the filters.

### Why Integration Tests

Unit tests with heavy mocking verify that your mocks work, not that your system works. Integration tests exercise the real system through its public interfaces — the same way a client or user would interact with it.

### Rules

- **Never modify production code to make a test pass.** No test-only branches, no exporting internals, no `NODE_ENV` checks in business logic.
- **Black-box testing only.** Test through public interfaces: HTTP endpoints, CLI commands, file system outputs, the rendered DOM (frontend).
- **Real infrastructure.** For databases use test containers, not mocks. For file-based state use temporary directories. Start real servers on random ports.
- **External-only stubs at the network boundary.** Mock only services your process calls *out* to (third-party APIs, agent binaries, GitHub, etc.) using an **Express stub on a random port + env-var override** read at request time. Do NOT use MSW (it misses subprocess-originated traffic, and the env-var indirection is what forces the production code into a testable shape). Do NOT use `page.route()` to intercept your own backend routes from a Playwright test. Do NOT add a tRPC mock layer.
- **Coding agents are stubbed at the ACP boundary.** Chats talk to agents over the Agent Client Protocol; tests set `BAND_TEST_ACP_AGENT` to the scripted stub agent `apps/hub/tests/fixtures/acp-stub-agent.mjs` (scenario, capabilities and request log are env-configured — see its header and `apps/hub/tests/helpers/acp-chat.ts`). Don't mock the ACP SDK or the agent-session service.
- **Test framework: match the package.** `node:test` with `node:assert/strict` is the default for new code. The web app (`apps/web`) and the hub (`apps/hub`) are the exception: they already standardised on **vitest** before this convention was written down (the existing test suites use `describe`/`it`/`expect`/`beforeAll` from `vitest`), so new tests under `apps/hub/tests/` and `apps/web/tests/` should use vitest too rather than mix runners in one package. Don't add test framework dependencies elsewhere unless already present.

See the `write-integration-test` skill (`.claude/skills/write-integration-test/SKILL.md`) for the full doctrine — backend + frontend integration tests, Express-stub patterns, page-object conventions, the universal checklist, and worked examples.

### Frontend tests (web app)

**Frontend tests follow the same integration doctrine as backend tests** — they boot the real server (the production `dist/start-server.mjs` bundle), drive it through a real Chromium via Playwright, and assert on the real rendered DOM / `localStorage` / URL state. Read [`docs/integration-testing.md`](docs/integration-testing.md) and the `write-integration-test` skill (`.claude/skills/write-integration-test/`) before authoring frontend tests.

The non-negotiables for any new frontend test:

- **Boot the real server** with `apps/web/e2e/helpers/server.ts` (`startServer` + `createTmpHome` + `seedState` + `seedSettings`). No in-process React mounting. No shallow renders. No `jsdom` + `renderHook` for behaviour that's user-observable.
- **No tRPC mocking.** No `createTrpcMock`. No `page.route('**/trpc/**', …)`. The existing `apps/web/e2e/helpers/trpc-mock.ts` and the two `worktree-switch-*.spec.ts` files that use it are technical debt to be migrated, not a pattern to copy.
- **Page Object Model.** Locators (`getByRole`, `getByTestId`) live on a page object class under `apps/web/e2e/pages/`. The test body never calls `page.goto()`, `page.getByRole()`, `page.getByTestId()` directly — only methods like `worktreePage.maximizePanel()`.
- **Locator priority for elements your code owns:** `getByRole({ name })` when the ARIA name is system-controlled; otherwise `getByTestId("page__element")` (BEM convention). Banned: CSS selectors, element IDs, `getByText` for localisable copy.
- **External services get Express stubs** under `apps/web/e2e/fixtures/` (or `apps/hub/tests/fixtures/` if shared with backend tests). One stub per env var. Subprocess-originated traffic (`codex`, `claude-code`, `git`) is exactly the case where MSW would silently fail — Express stubs cover it.
- **Production code reads outbound URLs from env vars at request time**, not at module load (`axios.create({ baseURL })` at module top is wrong). Refactoring that pattern is the only allowed production-code change a test may introduce, alongside `data-testid` attributes on JSX.
- **Wait properly.** `expect(locator).toBeVisible()` and `expect.poll(() => …)` auto-retry. Never `page.waitForTimeout(N)`.

Look at `apps/web/e2e/worktree-maximize-state.spec.ts` and `apps/web/e2e/pages/WorktreePage.ts` as the model — they follow the doctrine end-to-end. Run frontend tests with `pnpm --filter @band-app/web test:e2e`; backend integration tests with `pnpm --filter @band-app/server test`.

### Mobile app (apps/mobile)

`apps/mobile` (`@band-app/mobile`) is the Expo iOS app. Its unit tests are `node:test` over the pure modules (`pnpm --filter @band-app/mobile test`), and `pnpm --filter @band-app/mobile typecheck` runs tsc. To verify a mobile change end to end, follow the `mobile-verify` skill (`.claude/skills/mobile-verify/SKILL.md`): it starts a throwaway hub, builds and installs the app on an iOS simulator, runs the Maestro flows in `apps/mobile/e2e/` and saves screenshots for `/am-verify`.

### Running the hub suite locally

`pnpm install`, then `pnpm --filter @band-app/server test`. The `pretest` script builds the web app and the hub bundle first. Use Node 24 (`.nvmrc`); the default Node on some machines is newer and breaks other suites.

- The band CLI: `apps/hub/tests/global-setup.ts` runs `cargo build --manifest-path apps/cli/Cargo.toml` once when no CLI newer than `apps/cli/src`, `skills` and `Cargo.*` exists, after which tests find it under `apps/cli/target`. It needs Rust. Without it the run stops with one message saying how to build the CLI. Set `BAND_CLI_PATH` to use a binary you built yourself.
- pnpm under a temp HOME: `vitest.config.ts` sets `COREPACK_HOME` to the cache of your real HOME (`~/.cache/node/corepack`, or `XDG_CACHE_HOME`) and turns the download prompt off, so `dev-server` and `plain-repos` find pnpm without the network. Run pnpm once (any `pnpm install`) so the cache holds it.
- Network: after the install and the CLI build, the suite needs none. `runner-docker`, `runner-k8s-kind` and `environment-build-docker` skip without Docker or a cluster.
- Leaked processes: `tests/setup-process-guard.ts` preloads `scripts/test-process-guard.mjs` into every node process a hub test starts, so a worker, terminal daemon or agent daemon exits within about 2 s of the test process dying, SIGKILL included. Get the worker path from `tests/helpers/worker-bin` (`scripts/check-test-worker-spawn.sh` runs in `pnpm lint`) and add `processGuardEnv()` when a spawn builds its environment from scratch. `scripts/worktree-teardown.sh` is the worktree's `teardown` and kills what still runs under the worktree path.
- Teardown: start servers with `startServer` from `tests/helpers/server.ts`, which waits for the server's process group before the test deletes its temp home, and delete the home with `removeTmpHome` (`tests/helpers/tmp-home.ts`), which lists leftover files when the delete fails with ENOTEMPTY.

### Running the suites inside a Band worker

An agent session runs in a Band worker, so its environment carries the worker's identity: `BAND_WORKER_ID`, `BAND_HUB_URL`, `BAND_SERVER_URL`, `BAND_TOKEN`, `BAND_WORKTREE_ID`, `BAND_CHAT_ID`, and the variables its profile maps (such as `GH_TOKEN`), and possibly `GIT_ASKPASS` and `SSH_ASKPASS`. A test that starts a hub, a `band-worker` or the CLI used to inherit them. The hub then refused a test worker's bootstrap token with HTTP 401 (the id belonged to the real worker), and the CLI talked to the real hub (`Repo "my-repo" not found`). Tests that fetch fake repos such as `acme/widgets` (`pr-checks`, `subscriptions-github*`, `subscriptions-guards`) also made the real hub log credential requests through the inherited helper. The suites now drop these variables themselves, through `scripts/test-env.mjs` (called by `apps/hub/vitest.config.ts` and `apps/web/playwright.config.ts`) and `command()` in `apps/cli/tests/integration.rs`. A new helper that spawns a process still builds its environment from `process.env`, which is clean by then. Do not add a spawn that reads the real `~/.band`.

- Use Node 24: `export PATH=~/.nvm/versions/node/v24.22.1/bin:$PATH` (the default Node here is newer).
- Hub: `pnpm --filter @band-app/server test`. The full run takes 30+ minutes.
- Web e2e: `pnpm --filter @band-app/web test:e2e`. Specs that start a real `band-worker` failed at the 5 s `expect` default, because the worker runs from TypeScript source through tsx and needs longer on a cold start. `playwright.config.ts` sets `expect.timeout` to 30 s. The `webkit-iphone` project is skipped, with a message, when WebKit is missing. Install it with `pnpm --filter @band-app/web exec playwright install webkit` to run it.
- CLI: `cargo test --manifest-path apps/cli/Cargo.toml`. It needs `apps/hub/dist`, so run `pnpm --filter @band-app/server build` first.
- macOS has no `timeout`. Bound a command with `node scripts/with-timeout.mjs <seconds> <command> [args...]`. It stops the whole process group after the limit and exits 124.
- `pnpm install --ignore-scripts` leaves node-pty's `spawn-helper` non-executable, so terminal tests fail until you run `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`.

### Where tests run

Pull requests run the Linux jobs only: lint, the hub suite in 2 shards, the web unit and package suites, the web e2e suite, the remote-loopback job (one shard, listed files only), Docker and k8s (kind). No macOS job runs on a pull request.

The web e2e job on a pull request runs only the specs the change affects, plus a smoke set (`scripts/ci/affected-e2e.mjs`, tested by `scripts/ci/affected-e2e.test.mjs` against the changed-file lists of real PRs). A changed spec runs. A changed page object, fixture or helper under `apps/web/e2e/` runs every spec that imports it, directly or through another page object. A changed `.ts` or `.tsx` file under `apps/web/src/` runs the specs whose page objects or specs mention one of its `data-testid`s (a file with none borrows the ids of what imports it, two levels up). A change to the hub, workers, the CLI, `packages/`, `plugins/`, `apps/web/package.json`, the e2e config, the lockfile or the CI files, a source file the mapping cannot place, or an error in the script runs every spec. Changes under `apps/mobile`, `apps/desktop`, `docs/` and the hub's own tests run only the smoke set. A selection of more than 40 specs runs in 3 shards, a smaller one in one. Pushes to main and the merge queue always run every spec (the nightly run starts only macOS jobs), so a mapping the script missed fails in the queue and not on the PR.

The merge queue starts a macOS job only when the change touches code that behaves differently there. `scripts/ci/macos-changes.sh` holds the path lists (`scripts/ci/macos-changes.test.mjs` tests them, run it with `node --test scripts/ci/macos-changes.test.mjs`):

- `cli-macos` (CLI integration tests): `apps/cli/`, and the worktree sync files behind the `/var/folders` path bug.
- `machine-macos`: `packages/host-local/`, `packages/link/`, the worker's service, terminal, agent, update and lease code, and the hub test files listed in `scripts/ci/macos-hub-tests.txt`. It runs those hub files and the host-local, link and worker package tests, not the whole hub suite.
- `desktop-macos`: `apps/desktop/`, the bundled worker, the direct path and `apps/web/e2e-desktop/`. `desktop-packaged-macos` runs two specs of the packaged app as a smoke check, only when `electron-builder.yml`, `apps/desktop/`, `apps/worker/scripts/` or the lockfile changed.
- `mobile-ios`: `apps/mobile/` and the packages it imports.

A change to `ci.yml` or the filter script starts every job, the full-suite jobs included. A push to main starts none, because the merge queue tested that commit. `scripts/check-ci-green.sh` accepts the queue's `merge_group` run of the same SHA for the release gate.

The nightly run (`schedule` in `ci.yml` at 02:30 UTC, also `workflow_dispatch`) runs every macOS job in full: the whole hub suite on macOS in 2 shards with the web unit and package suites in shard 1 (`web-macos`), the whole packaged desktop e2e and the CLI suite. A macOS-only break outside the filtered paths first shows up there. Look at the Actions tab, workflow CI, event "schedule". A test that needs macOS to fail is still written as an ordinary test, with no list to join.

In the nightly run each `web-macos` shard runs its half of the hub suite with `vitest run --shard=N/2` after its own `pnpm build:web`, not `pnpm --filter @band-app/server test`, so the `pretest` build does not repeat. Locally, `pnpm --filter @band-app/server test` still builds first.

Hub test files run in parallel: `apps/hub/vitest.config.ts` uses the `forks` pool with 3 workers (`BAND_TEST_WORKERS` overrides it), because every server, worker and daemon a test starts has a random port and its own temp HOME. No file opts out. A new test must not use a fixed port, a path outside its temp HOME, or the real `~/.band`; run it with `--no-file-parallelism` to find a collision.

The remote-loopback job runs only the files in `apps/hub/tests/loopback-files.txt`, the ones that import `helpers/test-host` (their behaviour depends on where the worktree lives). `scripts/check-loopback-files.sh` runs in `pnpm lint` and fails when a file that imports `helpers/test-host` is missing from the list, or the list names a file that does not exist. A test that should run on a loopback worker imports from `test-host` and goes in the list.

### Exceptions

The list of tests that call internals directly, and the production settings added for testability, is in `.claude/rules/test-exceptions.md`. It loads when you work in a test file. Read it before adding a new exception.

## UI errors

Show an error as an icon with a popover (destructive color, `aria-label` naming the problem), never as inline text. A row stays short at any width. Settings > Workers does this now. Other screens still print some errors inline.

## UI colors

Use the semantic tokens in `apps/web/src/styles/globals.css` (`bg-selection`, `text-success`, `text-git-added`, `var(--syntax-keyword)`), not Tailwind palette classes or color literals, so Settings > Appearance restyles every surface. `scripts/check-theme-tokens.mjs` fails `pnpm lint` and CI on `bg-blue-500`, `dark:text-red-400`, `#ff0000` or `rgba(...)` in `.ts` and `.tsx` files. A color that must stay fixed takes `theme-lint-ignore-line: <reason>` or `theme-lint-ignore-file: <reason>`. The token list and the theme runtime are in `docs/appearance.md`.

## Git Hooks & CI

This repo has a pre-push hook (`.husky/pre-push`) that runs linting, formatting, and clippy checks. **Never bypass git hooks** — do not use `--no-verify` on `git push` or `git commit`. If a hook fails, fix the underlying issue instead of skipping the check.

The pre-push hook also runs `scripts/flake-guard.mjs`. It repeats each test file the branch added or changed against the merge base with `origin/main`: e2e specs 5 times (`--repeat-each 5 --workers 1`), hub, web and package tests 3 times, and it blocks the push when any run fails. It stops after 15 minutes and lists what it did not cover, which does not block the push, and it skips a file it cannot run here (no browser, a failed build) with a message. `pnpm flake-guard` runs the fuller loop by hand (e2e 20, others 10, no cap); `--files`, `--repeat`, `--base` and `--max-minutes` adjust it.

**Always run `/review-and-apply` before pushing code.** This invokes the `review-and-apply` skill, which runs Band's CI-style PR review locally against the current branch, auto-applies the resulting fixes, and verifies them with lint/clippy/tests. Do the local review *before* `git push` so the same criteria CI uses catch issues while they're still cheap to fix.

PRs merge through GitHub's merge queue: once a PR is approved and its checks are green, run `gh pr merge <n> --auto --squash`. The queue builds a temporary branch of the PR on top of main and waits for `Lint, Test & Build` and `macOS, Docker & k8s` (the macOS, Docker image and k8s (kind) jobs, where a skip counts as a pass) on that branch before it squash-merges. Pull requests run Linux jobs, Docker and k8s (kind) only: every macOS job has `github.event_name != 'pull_request'`, so the macOS jobs first run in the merge queue, and only for the paths they cover (see Where tests run). A macOS-only failure elsewhere surfaces in the nightly run. Do not merge by hand, and do not update the branch or rebase to chase main; the queue tests against current main for you.

## Issue tracking

All issues are created in the `band-app/band` GitHub repo.

## Architecture: Hub and UI packages

`apps/hub` (`@band-app/server`) is the API server: tRPC, the raw HTTP and WebSocket handlers, the MCP endpoint, the database, the terminal daemon and its build (`scripts/build-server.sh`). `apps/web` (`@band-app/web`) is the React UI and its Playwright e2e specs. `packages/shared` (`@band-app/shared`) holds the types and small pure helpers both sides import (`chat-events`, `client-state-keys`, `toWorktreeId`, …); it was chosen over keeping them in the hub because the UI imports runtime values from it, and the UI may import only `type { AppRouter }` from `@band-app/server` (`apps/web/tests/hub-boundary.test.ts` enforces it).

The hub serves the built UI from `--ui-dir <path>` or `BAND_UI_DIR`. By default it looks for `apps/web/dist/client` in the worktree, then `client/` beside its bundle (the desktop app, the Docker image and the npm tarball ship it there). In dev, `pnpm dev` runs the hub with Vite mounted as middleware over `apps/web` (`BAND_UI_ROOT` overrides the root), so there is still one port with HMR.

## Architecture: worktree ids

A worktree id names its worker: `<repo>-<branch>` on the hub's own worker (`local`) and `<repo>-<branch>@<hostId>` on any other, so the same repo and branch on two workers would be two worktrees. Band creates only one of them now (see Architecture: repo workers), but rows from before that rule keep their ids. `toWorktreeId(repo, branch, hostId)` in `packages/shared/src/worktree-id.ts` is the only function that makes one (it returns the branded `WorktreeId`, and `hostId` has no default). `scripts/check-worktree-ids.sh` runs in `pnpm lint` and CI and fails on an id built by hand in production code. `WORKTREE_ID_MATCH` in `infra/db/queries/worktrees.ts` is the SQL twin. `worktrees.remove | setPinned | gitPull | gitPush` take an optional `hostId` to tell two same-named worktrees apart (the worker relay writes the caller's worker into `worktrees.remove`). The migration `worktree_host_ids` rewrites stored ids; where several workers shared one old id, state that names no worker goes to the lowest worker id. Not migrated: `<BAND_HOME>/sleep/<id>/`, `workspace-prompts/<id>.json`, a worker's WIP files, the ids inside `runner_snapshots.worktree_ids`, open `host_requests` (keyed by the worker-less id until a worker is chosen), and the chats and terminals of a remote worktree whose old id equals a local worktree's (they stay with the local one).

- A worktree whose folder is gone from a reachable worker gets `missing: true` in `repos.list` (the Missing badge and Remove in `WorktreeCard`). `repos.list` and `syncWorktrees` hand such rows to `worktreeService.pruneMissing`, which removes the record and runs `git worktree prune`, unless a chat there has a running task, a live agent or queued messages. `worktrees.remove` of a worktree whose folder or branch is already gone does the same and deletes no file and no branch.
- `BAND_LOCAL_WORKER=off`: `runFirstTimeSetup` calls `forgetLocalWorktrees` first, which deletes the local-worker worktree rows and the hub checkout path of git repos (files stay; plain folders stay). `repos.add` by path, `backfillRemotes`, the local part of `syncWorktrees` and `repos.list`, and `checkoutOn`'s clone all refuse or skip the hub's machine. The Worker grouping in the sidebar has no "This hub" group when `workers.list` has no `local` row. Tests: `apps/hub/tests/worktree-host-identity.test.ts`, `worktree-host-ids-migration.test.ts`.

## Architecture: machine access lives in host-local

Code that touches a machine (git and `gh`, the exec worker, ripgrep, the LSP manager (it spawns the language servers that installed extensions contribute), ACP launch and spawn, the terminal pool and daemon backend, setup scripts, the Claude environment readers and installers) lives in `packages/host-local` (`@band-app/host-local`). `LocalHost` implements the `Host` interface from `packages/host-api`. The hub imports it through `HostRegistry` (`apps/hub/src/server/infra/host/registry.ts`) and a few helpers by subpath (`@band-app/host-local/git/git-client`). The package has its own worker contract test and its own dependencies (node-pty, ripgrep, xterm, the ACP adapters). `apps/hub` still lists node-pty, ripgrep and the adapters, because its build script copies them into `dist/`.

Services may import from `@band-app/host-local` only the pure helpers and hub-side wiring listed in the `patterns` group in `biome.json` (`getRepoInfo`, `git-refusals`, `process/path`, the terminal backends). `gitRunner`, `ghRunner` and `CommandRun` live in `@band-app/host-api`. A service that reads a worktree's checkout calls `worktree.host` (`host.git.exec`, `host.fs.stat`, `host.fs.readFile`), never `node:fs` on `worktree.path`, because the worktree is on the worker's disk. The remote-loopback test job enforces this: `apps/hub/tests/helpers/worker-fs-guard.mjs` fails the hub on any fs or child process access under a worker's worktree, and `apps/hub/tests/remote-git-routing.test.ts` covers changes, diff, graph, branch status and sync for a remote worktree. `subscription-source-service` keeps `execGh` on the hub: it lends the GitHub plugin's subscription source a `gh` (webhook registration, check runs, comments and the authenticated user) that uses only the GitHub API and the hub's own `gh` login, and needs no checkout.

A Biome `style/noRestrictedImports` override in `biome.json` bans `node:fs`, `node:fs/promises`, `node:child_process`, `node-pty`, the exec worker and `execGit`/`execGh` in `apps/hub/src/server/services/**`, `apps/hub/src/server/api/**` and `packages/worktree-ops/src/**`. A second override lists the files exempt from it: hub state (CLI install, avatar cache, uploads, tasks, the PWA manifest, worktree prompt files) and `repo-service`, which still probes the hub's own repo directories with `existsSync`. A third override lets the GitHub webhook and poll services keep calling `execGit` and `execGh`, while still banning `node:fs`, `node:child_process` and `node-pty`. A new service that needs a machine goes through `host.*`. Adding it to the exempt list needs a reason.

## Architecture: Hub vs Desktop App

The hub (`apps/hub`) handles **data, state, and background processes** only. It must never invoke macOS-only shell helpers (folder pickers, Finder reveal, opening apps, installing the CLI symlink with administrator privileges). Those bridges live in the Electron desktop app (`apps/desktop/src/main/ipc/macos-shell.ts`) and are invoked from the React webview via the IPC bridge in `apps/web/src/lib/desktop-ipc.ts`, which talks to the preload script at `apps/desktop/src/preload/index.cts`.

## Band CLI Skills

The Band CLI ships **seven domain-specific skills**, each authored directly as `apps/cli/skills/<name>/SKILL.md` — that file is the single source of truth and is baked into the Rust binary via `include_str!`:

The list is `ls apps/cli/skills`.

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

**Supported coding agents** (Band creates a symlink for each one whose config dir is present on the worker):

The table is `SUPPORTED_AGENT_TYPES` in `packages/coding-agent/src/install-skills.ts`.

`cursor-cli` is deliberately excluded — Cursor has no documented user-scope skills directory.

The list of supported agents lives in `packages/coding-agent/src/install-skills.ts::SUPPORTED_AGENT_TYPES` (a single place to update when a new agent adds skills support). The write/symlink logic lives in the Rust CLI (`apps/cli/src/skills.rs::install_skills`); the web server's `apps/hub/src/server/services/cli-skills-service.ts::installSkills` shells out to `band skills install` on every boot from `runFirstTimeSetup`. It's idempotent: an existing symlink pointing at the right shared dir is left alone, an existing symlink pointing elsewhere (or a real directory occupying the path) is reported as a conflict rather than overwritten.

### Install

- `band skills install` — write the seven embedded SKILL.md files into `~/.agents/skills/`, then symlink each detected coding agent's skills directory. Idempotent. Useful for users running the CLI outside the Band dashboard, or for forcing a re-sync without rebooting the web server. The Band web server invokes this same subcommand on every boot from `runFirstTimeSetup`, so most users never need to call it directly.

To change a skill's content, edit `apps/cli/skills/<name>/SKILL.md` directly and rebuild the CLI — there is no generation step.

`band skills install --help` lists its flags (`--home`, `--filter`).

## Architecture notes

Each feature area's architecture note lives in `.claude/rules/architecture/<name>.md`. A note loads on its own when you work on a file it names. Read a note directly when a task touches its area before you have opened any of its files.

- `repos-by-remote-url`: repos by remote URL
- `hub-tokens`: hub tokens
- `voice-dictation`: voice dictation
- `credential-vault`: credential vault
- `mcp-proxy`: MCP proxy
- `repo-workers`: repo workers
- `worker-trust-levels`: worker trust levels
- `remote-workers`: remote workers
- `local-direct-path`: local direct path
- `worker-provisioning`: worker provisioning
- `worker-profiles`: worker profiles
- `version-updates`: version updates
- `desktop-workers`: desktop workers
- `agent-environments`: agent environments
- `agents-across-workers`: agents across workers
- `placement-and-worker-requests`: placement and worker requests
- `runners`: runners
- `checkpoints`: checkpoints
- `follow-the-work`: follow the work
- `ephemeral-lifecycle`: ephemeral lifecycle
- `distribution`: distribution
- `headless-hub-deploy`: headless hub deploy
- `this-computer-as-a-worker`: this computer as a worker
- `desktop-hub-picker`: desktop hub picker
- `browser-profiles`: browser profiles
- `plugins`: plugins
- `worktree-groups`: worktree groups
- `extensions`: extensions
- `html-visual-edit`: HTML visual edit
- `origin-links`: origin links
- `agent-sessions`: agent sessions
- `chat-ownership`: chat ownership
- `subscriptions`: subscriptions
- `cronjobs`: cronjobs
- `battery-saver`: battery saver
- `agent-status-states`: agent status states
- `account-usage`: account usage
- `center-layout`: center layout
- `client-state`: client state
- `agent-daemon`: agent daemon
- `web-server-vs-terminal-daemon`: Web Server vs Terminal Daemon
- `opening-files`: opening files
- `plugin-worker-half`: plugin worker half
- `resources-page`: resources page
