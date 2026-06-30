/**
 * End-to-end coverage for terminal file links.
 *
 * Feature: a file-path reference printed in the terminal (e.g.
 * `zz/link-target.ts:7`) is a clickable link; clicking it opens that file in
 * the file browser. The mechanism mirrors chat file links — the xterm link
 * provider dispatches the same workspace-scoped `band:open-file` window
 * event, which routes the path through Quick Open into the Files panel. When
 * the path resolves to a single workspace file, Quick Open opens it directly
 * (no intermediate dialog). See `lib/terminal-file-links.ts` and
 * `ai-elements/file-link-components.tsx`.
 *
 * This boots the production server bundle against a tmp `~/.band/`, opens a
 * real terminal (real PTY), prints a path to a file that exists in the
 * workspace, clicks the rendered link, and asserts the file lands open in the
 * file browser (Files tab active + the file persisted into the open-tabs
 * localStorage entry).
 *
 * Renderer note: xterm paints to a `<canvas>` under its default WebGL
 * renderer, leaving no hittable DOM text to click. The link provider itself
 * is renderer-agnostic (xterm's link layer hit-tests cell ranges the same way
 * under either backend), so we force the DOM renderer via
 * `seedSettings({ useWebGLTerminalRenderer: false })` purely so the printed
 * path exists as locatable DOM text — see `WorkspacePage.clickTerminalFileLink`.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const TOKEN = "e2e-terminal-file-links-token";
const PROJECT = "alpha-terminal-file-links";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// A workspace-relative path (slash + known extension → `isFilePath` links it)
// with a line indicator. The `zz` prefix keeps it from colliding with
// anything a shell prompt might render on the same line. The file is created
// on disk below so Quick Open resolves it to exactly one result and opens it
// directly in the file browser.
const REL_PATH = "zz/link-target.ts";
const LINK_PATH = `${REL_PATH}:7`;

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// (which hosts the terminal container) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
/** A real directory used as the project path — the PTY spawns with cwd =
 *  the project path and `terminal-pool` throws if it doesn't exist. */
let workdir: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "band-term-links-workdir-")));
  // The file the terminal link points at — must exist so the file browser's
  // search resolves it and opens it directly.
  mkdirSync(join(workdir, "zz"), { recursive: true });
  writeFileSync(join(workdir, REL_PATH), "export const target = 1;\n", "utf-8");
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: workdir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdir }],
      },
    ],
  });
  // Force the DOM renderer so the printed path is locatable DOM text.
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal file links", () => {
  test("clicking a file path printed in the terminal opens it in the file browser", async ({
    page,
  }) => {
    // The xterm boot + PTY handshake carries the same generous budget the
    // other terminal specs use under CI worker contention.
    test.setTimeout(120_000);

    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(75_000);

    // Positive anchor: no file is open in the browser before the click.
    expect(await workspacePage.readOpenTabPaths(WORKSPACE)).not.toContain(REL_PATH);

    // Print the path on its own line. `runInTerminal` types the command and
    // submits it; the shell echoes `LINK_PATH` as a bare output line at
    // column 0, which the link provider turns into a clickable link.
    await workspacePage.runInTerminal(`echo ${LINK_PATH}`);

    await workspacePage.clickTerminalFileLink(LINK_PATH);

    // Observable outcome: the click routed the path into the file browser,
    // which switched to the Files tab and opened the file (persisted into the
    // workspace's open-tabs localStorage entry, line suffix stripped). This is
    // the same open-file surface a chat file-link click drives.
    await expect(workspacePage.tabContainer("files")).toHaveClass(/\bdv-active-tab\b/, {
      timeout: 15_000,
    });
    await expect
      .poll(async () => await workspacePage.readOpenTabPaths(WORKSPACE), { timeout: 15_000 })
      .toContain(REL_PATH);
  });
});
