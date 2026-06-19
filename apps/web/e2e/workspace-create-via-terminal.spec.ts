/**
 * End-to-end coverage for issue #551 — the dashboard surfaces a real
 * terminal pane after a CLI-initiated `workspaces.create --via terminal`.
 *
 * The test boots the production server bundle against a tmp `~/.band/`,
 * fires the same tRPC mutation the Rust CLI fires (no CLI binary
 * involved — the wire shape is what we're pinning), then drives the
 * dashboard via `WorkspacePage` to observe the rendered DOM. No tRPC
 * mocking, no in-process React.
 *
 * What's pinned:
 *
 *   1. `workspaces.create` with `via: "terminal"` returns a `terminalId`
 *      and `via: "terminal"` in the JSON payload (acceptance criterion).
 *   2. Navigating to the new workspace and clicking the outer terminal
 *      tab renders the xterm.js textbox — i.e. the layout actually picked
 *      up the spawned PTY, not just a tab that opens an empty panel
 *      (acceptance criterion: "dashboard shows a terminal pane").
 *
 * The vendor CLI itself is a 2-line shell stub (`stub-claude.sh`) so the
 * test doesn't depend on a real `claude` install. The terminal pool
 * writes the assembled command line to the spawned shell and the stub
 * echoes its argv; we don't assert on that output here (the backend
 * vitest at `tests/workspace-create-via.test.ts` already pins it). This
 * spec's job is the rendered-DOM half of the acceptance criteria.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-workspace-create-via-terminal-token";
const PROJECT = "viaproj";
const BRANCH = "main";

// Wide viewport so `useIsDesktop()` reports true and the shared
// dockview renders (matches >= 1024px in apps/web/src/hooks/useIsDesktop.ts).
// The terminal pane is part of the desktop layout's dockview; the
// mobile route uses a different surface and doesn't apply here.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let stubBin: string;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // Real git repo so the workspace resolves cleanly. `workspaces.create`
  // needs a `git worktree add` target — without a real repo it would
  // fail before we ever reach the terminal-spawn branch.
  repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, "README.md"), "# via terminal\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);

  // Stub vendor CLI — the adapter's `cliInvocation` returns this path
  // as `command`, the terminal pool wraps it in shell quotes and writes
  // it to the PTY. Stub exits quickly; we're testing UI surface, not
  // session conversation.
  stubBin = join(tmpHome, "stub-claude.sh");
  writeFileSync(
    stubBin,
    `#!/bin/sh\nprintf 'ARGV:'\nfor arg in "$@"; do printf '%s|' "$arg"; done\nprintf '\\n'\n`,
    "utf-8",
  );
  chmodSync(stubBin, 0o755);

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    // Claude-Code adapter — its constructor stores `executablePath` and
    // its `cliInvocation` echoes that back. Pointing it at our stub keeps
    // the spawned process under our control without faking the SDK.
    codingAgents: [
      {
        id: "claude-code",
        type: "claude-code",
        label: "Claude Code",
        command: stubBin,
      },
    ],
  });
  // Boot refresh fires for the seeded claude-code agent. The
  // 10 s timeout in `ClaudeCodeAdapter.refreshModels()` catches the
  // protocol-handshake failure against `stub-claude.sh`; the resulting
  // "refresh failed" log line is expected and benign.
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("workspaces.create --via terminal (issue #551)", () => {
  test("dashboard shows a terminal pane after a CLI-initiated --via terminal create", async ({
    page,
  }) => {
    // The xterm textbox assertion below carries a 75 s budget (see the
    // comment there); pair it with a 120 s test-level timeout so the
    // assertion budget plus the create + navigation steps still fit
    // inside one test under CI worker contention. Mirrors
    // `workspace-maximize-state.spec.ts`, which waits on the same
    // xterm-boot path with the same 75 s / 120 s pairing.
    test.setTimeout(120_000);

    // Phase 1: fire the same mutation the Rust CLI fires. The wire shape
    // is identical to `cmd_workspaces_create` after precedence resolution
    // (`apps/cli/src/main.rs`) — we don't invoke the CLI binary here
    // because the dashboard test only cares about the *server response*
    // and the *rendered DOM*, not the CLI flag/env plumbing (the Rust
    // integration tests cover that side). The raw `page.request.post`
    // lives on the `WorkspacePage` POM so the test body stays free of
    // request plumbing.
    const branch = "feat/via-e2e";
    const targetWorkspaceId = toWorkspaceId(PROJECT, branch);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const created = await workspacePage.createWorkspaceViaTerminal(
      PROJECT,
      branch,
      "implement feature E2E",
    );
    expect(created.via).toBe("terminal");
    // Single matcher rather than two checks: `toMatch(/^.+$/)` makes
    // `null`, `undefined`, and `""` each fail explicitly without the
    // `?? ""` fallback masking a `null`.
    expect(created.terminalId).toMatch(/^.+$/);

    // Phase 2: drive the dashboard to the newly-created workspace and
    // assert the terminal pane mounts. The outer shared dockview lays
    // out a `terminal` tab unconditionally; we click it to make sure
    // the terminal container becomes the active view, then anchor on
    // xterm's input element. The element is only emitted by xterm.js
    // once a PTY session is attached to its inner-dockview panel — so
    // its presence is the DOM-level proof that the spawned terminal
    // landed in the layout, not just an empty tab.
    await workspacePage.goto(targetWorkspaceId);
    await workspacePage.waitForReady();

    // xterm.js mounts on first visibility — `openTerminalTab` clicks
    // the outer terminal tab and triggers the layout activate → React
    // render → xterm init handshake. The 75 s budget passed to
    // `waitForTerminalReady` mirrors `workspace-maximize-state.spec.ts:346`
    // for CI parity; locally the element attaches in < 2 s.
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(75_000);
  });
});
