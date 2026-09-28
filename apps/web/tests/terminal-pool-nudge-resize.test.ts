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
// so this drives `TerminalPool` directly with a real PTY. The
// serialized-replay payload itself is user-observable and is covered at the
// WS layer in terminal-ws.test.ts.

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
  it("shrinks the PTY rows and restores the original dims", async () => {
    const root = makeWorkdir();
    const pool = new TerminalPool();
    cleanups.push(() => pool.killAll());
    const terminalId = "term-nudge";
    const session = await pool.spawn("proj/main", terminalId, root);
    expect(session.pty.rows).toBe(24);

    pool.nudgeResize(terminalId);
    // Rows shrink applies synchronously (rows, not cols — a column change
    // would re-wrap the whole mirror scrollback); restore lands after ~50 ms.
    expect(session.pty.rows).toBe(23);
    expect(session.pty.cols).toBe(80);
    await expect.poll(() => session.pty.rows, { timeout: 5_000 }).toBe(24);
    expect(session.pty.cols).toBe(80);
  }, 20_000);

  it("concurrent nudges do not compound — second nudge is a no-op while one is in flight", async () => {
    const root = makeWorkdir();
    const pool = new TerminalPool();
    cleanups.push(() => pool.killAll());
    const terminalId = "term-nudge-dedupe";
    const session = await pool.spawn("proj/main", terminalId, root);

    // Two clients re-attaching together fire two nudges back-to-back.
    // Without dedupe the second would shrink 23→22 and the restores would
    // land on the wrong dims, leaving the PTY one row short forever.
    pool.nudgeResize(terminalId);
    pool.nudgeResize(terminalId);
    expect(session.pty.rows).toBe(23);
    await expect.poll(() => session.pty.rows, { timeout: 5_000 }).toBe(24);
    expect(session.pty.cols).toBe(80);
  }, 20_000);
});
