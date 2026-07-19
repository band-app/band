import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalPool } from "../src/server/infra/terminals/terminal-pool.ts";

// `nudgeResize` is the shrink-and-restore SIGWINCH pair fired after a
// reconnect replay so a live full-screen TUI repaints for the re-attached
// client (see attachSession in api/terminals/ws.ts). Its only hermetic
// observable is the PTY dims themselves — observing the resulting repaint
// over the `/terminal` WS would require a SIGWINCH-aware TUI binary in CI —
// so this drives `TerminalPool` directly with a real PTY, per the exception
// noted in CLAUDE.md. The serialized-replay payload itself is user-observable
// and is covered at the WS layer in terminal-ws.test.ts.

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {}
  }
  cleanups.length = 0;
});

function makeWorkdir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "band-pool-nudge-")));
  cleanups.push(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  return dir;
}

describe("TerminalPool.nudgeResize — post-replay repaint trigger", () => {
  it("shrinks the PTY and restores the original dims", async () => {
    const root = makeWorkdir();
    const pool = new TerminalPool();
    cleanups.push(() => pool.killAll());
    const terminalId = "term-nudge";
    const session = await pool.spawn("proj/main", terminalId, root);
    expect(session.pty.cols).toBe(80);

    pool.nudgeResize(terminalId);
    // Shrink applies synchronously; the restore lands after ~50 ms.
    expect(session.pty.cols).toBe(79);
    await expect.poll(() => session.pty.cols, { timeout: 5_000 }).toBe(80);
    expect(session.pty.rows).toBe(24);
  }, 20_000);
});
