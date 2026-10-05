/**
 * End-to-end coverage for the terminal tab's right-click "Copy terminal ID"
 * context-menu action.
 *
 * Architecture (mirrors the rest of the e2e suite):
 *   - REAL production `dist/start-server.mjs` boots against a fresh tmp
 *     `$HOME` with an on-disk repo worktree. No tRPC mocking — the
 *     terminal is created through the same pipeline production uses, so its
 *     id is server-assigned rather than test-fabricated.
 *   - Clipboard writes are captured via `WorktreePage.installClipboardCapture`,
 *     which removes `navigator.clipboard` (the non-secure / LAN-IP case) and
 *     records the `execCommand("copy")` fallback payload. That doubles as a
 *     regression guard: code that bypassed the shared `writeClipboardText`
 *     helper and called `navigator.clipboard` directly would copy nothing
 *     here and fail the assertion.
 *
 * The asserted value is the id the app actually rendered — read back from the
 * terminal wrapper's `data-terminal-id` — so the test proves the menu copies
 * THIS terminal's id, not a guessed constant.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-terminal-copy-id-token";
const REPO = "alpha-terminal-copy-id";
const WORKTREE = toWorktreeId(REPO, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// (which hosts the terminal container) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
/** A real directory used as the repo path — the PTY spawns with cwd =
 *  the repo path and `terminal-pool` throws if it doesn't exist, so a
 *  fake `/tmp/...` path (fine for layout-only tests) won't work here. */
let workdir: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "band-term-copyid-workdir-")));
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: workdir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdir }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal tab: Copy terminal ID", () => {
  test("right-click → Copy terminal ID copies this terminal's id to the clipboard", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    // Must run before `goto` (installs an init script that removes
    // `navigator.clipboard` and records the execCommand fallback).
    await worktreePage.installClipboardCapture();

    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForReady();
    await worktreePage.openTerminalTab();
    await worktreePage.waitForTerminalReady();

    // The id the app assigned to the terminal it just booted.
    const terminalId = await worktreePage.readActiveTerminalId(WORKTREE);
    expect(terminalId).not.toBe("");

    await worktreePage.openTerminalTabContextMenu();
    // Positive anchor: the menu content actually opened before we assert on
    // (and click) an individual item — mirrors the chat-tab spec.
    await expect(worktreePage.terminalTabContextMenu).toBeVisible();
    await expect(worktreePage.copyTerminalIdItem).toBeVisible();
    await worktreePage.clickCopyTerminalId();

    // The copied payload is exactly the rendered terminal id.
    await expect
      .poll(async () => (await worktreePage.readCopied()).at(-1), {
        message: "terminal id copied to clipboard",
        timeout: 15_000,
      })
      .toBe(terminalId);
  });
});
