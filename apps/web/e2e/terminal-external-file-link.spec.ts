/**
 * End-to-end coverage for clicking a terminal link that points at a file
 * OUTSIDE the workspace worktree.
 *
 * Feature: a file-path reference printed in the terminal is a clickable link
 * (see `lib/terminal-file-links.ts`). The existing `terminal-file-links.spec`
 * covers a workspace-relative path resolving into the Files panel. This spec
 * covers the sibling case the user asked for: an ABSOLUTE path to a file that
 * lives outside the worktree (e.g. `/tmp/band-terminal-repair-task.md`).
 * Clicking it dispatches the same `band:open-file` event, which Quick Open
 * now probes against the host filesystem (`host.statFile`) and — since the
 * file exists — opens as an external editor tab via the same pipeline the
 * CLI's `band open <abs>` uses.
 *
 * Boots the production server bundle against a tmp `~/.band/`, opens a real
 * terminal (real PTY), prints an absolute path to a file that exists outside
 * the workspace, clicks the rendered link, and asserts the file lands open as
 * an external tab (Files tab active + the absolute path persisted into the
 * open-tabs localStorage entry).
 *
 * Renderer note: xterm paints to a `<canvas>` under WebGL, leaving no
 * hittable DOM text. We force the DOM renderer via
 * `seedSettings({ useWebGLTerminalRenderer: false })` so the printed path
 * exists as locatable DOM text — same carve-out as `terminal-file-links.spec`.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const TOKEN = "e2e-terminal-external-file-link-token";
const PROJECT = "alpha-terminal-external-link";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// (which hosts the terminal container) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
/** The project path — the PTY spawns with cwd = the project path. */
let workdir: string;
/** A directory OUTSIDE the workspace holding the external file. */
let externalDir: string;
/** Absolute path to the external file the terminal link points at. */
let externalPath: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "band-term-ext-workdir-")));
  // The external file — outside the worktree, reachable only by absolute
  // path. Deliberately created under a SHORT base (`/tmp`, like the user's
  // real `/tmp/band-terminal-repair-task.md` example) rather than the OS
  // tmpdir: on macOS `os.tmpdir()` is a ~57-char `/private/var/folders/…`
  // path, which pushes the printed line past the terminal's width so it
  // wraps — and the link provider deliberately doesn't linkify a path split
  // across rows. We do NOT canonicalize the `/tmp` symlink: the Quick Open
  // path passes the string through verbatim, and `host.statFile` opens it
  // fine (its O_NOFOLLOW guards only the final path component, not the
  // intermediate `/tmp` → `/private/tmp` symlink on macOS).
  externalDir = mkdtempSync(join("/tmp", "bext-"));
  externalPath = join(externalDir, "n.md");
  writeFileSync(externalPath, "# notes\n\noutside the worktree\n", "utf-8");

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
  rmSync(externalDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal links to files outside the worktree", () => {
  test("clicking an absolute path printed in the terminal opens it as an external tab", async ({
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

    // Positive anchor: the external file is not open before the click.
    await expect
      .poll(async () => await workspacePage.readOpenTabPaths(WORKSPACE), { timeout: 5_000 })
      .not.toContain(externalPath);

    // Print the absolute path on its own line; the shell echoes it as a bare
    // output line the link provider turns into a clickable link.
    await workspacePage.runInTerminal(`echo ${externalPath}`);
    await workspacePage.clickTerminalFileLink(externalPath);

    // Observable outcome: the click routed the absolute path through Quick
    // Open, which opened it as an external tab (Files tab active + the
    // absolute path persisted into the workspace's open-tabs entry).
    await expect(workspacePage.tabContainer("files")).toHaveClass(/\bdv-active-tab\b/, {
      timeout: 15_000,
    });
    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE))?.active, {
        timeout: 15_000,
      })
      .toBe(externalPath);
  });
});
