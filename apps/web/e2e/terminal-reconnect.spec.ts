/**
 * Regression coverage: a terminal must never be permanently disconnected
 * by a transient network drop / machine sleep.
 *
 * Background
 * ----------
 * When the machine sleeps (or the network drops), the terminal WebSocket
 * dies. The server has always kept the PTY alive across a socket close and
 * reuses it by `terminalId` on reconnect (see
 * `apps/web/src/server/api/terminals/ws.ts`). The missing half was the
 * client: `TerminalPanel` only printed "[Terminal disconnected]" and never
 * reconnected, so after a wake the pane was dead until the user manually
 * closed and reopened the tab. The fix adds client auto-reconnect (with an
 * application-level heartbeat + `online`/`visibilitychange` triggers) so the
 * pane re-attaches to the same PTY on its own.
 *
 * What this spec asserts (all black-box, renderer-independent)
 * ------------------------------------------------------------
 *   1. A shell variable is set in the PTY and confirmed live by echoing it
 *      to a file the test reads back.
 *   2. The live WebSocket is force-closed from inside the page (the
 *      deterministic stand-in for the TCP death a machine sleep causes —
 *      Chromium's `context.setOffline` does NOT drop an established
 *      loopback socket).
 *   3. The page opens a *second* terminal WebSocket (tracked at the
 *      protocol level via `page.on("websocket")`) — proof the client
 *      auto-reconnected rather than sitting dead, which is exactly what the
 *      old `onclose` handler did.
 *   4. Echoing the variable set BEFORE the drop writes the original marker
 *      to a new file — proof the reconnected client is driving the SAME
 *      shell, not a freshly-spawned one (a new PTY would have an empty
 *      `$MARKER`). This single assertion proves both halves: a reconnect
 *      happened AND the PTY session survived the disconnect.
 *
 * This exercises the close→reconnect path (the primary fix). The
 * application-level heartbeat and `online`/`visibilitychange` triggers are
 * additional defenses for the case where the socket goes "zombie" (stuck
 * OPEN, no `onclose`) after sleep.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

const TOKEN = "e2e-terminal-reconnect-token";
const PROJECT = "alpha-terminal-reconnect";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const MARKER = "band-reconnect-marker-7f3c";

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// (which hosts the terminal container) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
/** A real directory used as the project path — the PTY spawns with cwd =
 *  the project path and `terminal-pool` throws if it doesn't exist, so a
 *  fake `/tmp/...` path (fine for layout-only tests) won't work here. */
let workdir: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "band-term-workdir-")));
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
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Read a marker file written by the shell, or `null` if it doesn't exist
 *  yet. Trimmed because `echo` appends a trailing newline. */
function readMarker(file: string): string | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8").trim();
}

test.describe("Terminal reconnect across a network drop (machine sleep)", () => {
  test("the shell session survives a disconnect and the client reconnects to it", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const terminalSocketOpens = workspacePage.trackTerminalSocketOpens();
    await workspacePage.installTerminalSocketInstrumentation();
    const beforeFile = join(workdir, "before.txt");
    const afterFile = join(workdir, "after.txt");

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady();

    // The first socket is open.
    await expect.poll(() => terminalSocketOpens(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // Establish session state that only survives as long as THIS shell
    // process does: a variable unique to this PTY. No quotes / spaces around
    // the redirect so a keystroke dropped mid-reconnect can't wedge the
    // shell at a continuation prompt.
    await workspacePage.runInTerminal(`MARKER=${MARKER}`);

    // Positive anchor: the variable is set and input is routed to a live PTY.
    await expect
      .poll(
        async () => {
          await workspacePage.runInTerminal(`echo $MARKER>${beforeFile}`);
          return readMarker(beforeFile);
        },
        { timeout: 15_000 },
      )
      .toBe(MARKER);

    // Drop the connection mid-session, simulating the socket dying on sleep.
    await workspacePage.dropLatestTerminalSocket();

    // Protocol-level proof of reconnect: a second terminal WebSocket opens.
    await expect.poll(() => terminalSocketOpens(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

    // Prove the reconnected client drives the ORIGINAL shell: echo the
    // variable set BEFORE the drop. A freshly-spawned PTY would have an
    // empty `$MARKER`, so `afterFile` would never equal MARKER. Retried via
    // poll because keystrokes typed before the reconnect fully settles are
    // dropped (the leading Enter in `runInTerminal` keeps a partial attempt
    // from wedging the next one).
    await expect
      .poll(
        async () => {
          await workspacePage.runInTerminal(`echo $MARKER>${afterFile}`);
          return readMarker(afterFile);
        },
        { timeout: 20_000 },
      )
      .toBe(MARKER);
  });
});
