import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalPool } from "../src/server/infra/terminals/terminal-pool.ts";

// Regression for band-app/band#617: a single terminal is created via TWO
// concurrent server paths — the WebSocket handler (spawn-on-`getSession`-miss)
// and the tRPC `terminal.create` mutation. Before the fix, `pool.spawn` had no
// dedup: each call spawned its own PTY and the second `terminals.set` overwrote
// the first, so the client stayed wired to one PTY while the server's session
// map (scrollback / `terminals output` / reconnect-replay) pointed at the
// other. Symptom: output shows on screen but the server scrollback is empty,
// and it "reconnects" to the empty PTY on reload.
//
// This drives `TerminalPool.spawn` directly (like `git.test.ts` /
// `branch-status-poller-ci-throttle.test.ts` — see CLAUDE.md → Testing →
// Exceptions): the double-spawn is a nondeterministic race that can't be forced
// reliably through the full WS + tRPC stack, and dedup is internal server
// behaviour. A real PTY is spawned in a real temp dir — no mocks.

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "band-pool-dedup-")));
  cleanups.push(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  return dir;
}

describe("TerminalPool.spawn deduplication (#617)", () => {
  it("returns a single shared PTY for concurrent spawns of the same terminalId", async () => {
    // Register the workdir cleanup first so that (LIFO) `killAll` runs BEFORE
    // the temp dir is removed — kill the PTYs before deleting their cwd.
    const root = makeWorkdir();
    const pool = new TerminalPool();
    cleanups.push(() => pool.killAll());
    const workspaceId = "proj/main";
    const terminalId = "term-concurrent";

    // Two spawns fire concurrently for the SAME terminalId — the WS + tRPC race.
    const [a, b] = await Promise.all([
      pool.spawn(workspaceId, terminalId, root),
      pool.spawn(workspaceId, terminalId, root),
    ]);

    // Both callers get the exact same session (one PTY), and it is the one the
    // pool tracks — so the client's socket and the server's scrollback can never
    // diverge onto competing PTYs.
    expect(a).toBe(b);
    expect(pool.get(terminalId)).toBe(a);
    expect(pool.list(workspaceId)).toHaveLength(1);
  });

  it("is idempotent — a later spawn returns the already-live session", async () => {
    const root = makeWorkdir();
    const pool = new TerminalPool();
    cleanups.push(() => pool.killAll());
    const workspaceId = "proj/main";
    const terminalId = "term-idempotent";

    const first = await pool.spawn(workspaceId, terminalId, root);
    const second = await pool.spawn(workspaceId, terminalId, root);

    expect(second).toBe(first);
    expect(pool.list(workspaceId)).toHaveLength(1);
  });
});
