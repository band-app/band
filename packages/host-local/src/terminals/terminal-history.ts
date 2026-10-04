import { readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";

const log = createLogger("terminal-history");

/**
 * A serialized checkpoint over this size is dropped rather than written: the
 * headless mirror already bounds normal content to
 * `HEADLESS_SCROLLBACK_LINES` (`terminal-pool.ts`), so hitting this is a sign
 * something is unusual (e.g. a single absurdly wide line), not a case worth
 * trimming carefully for.
 */
const CHECKPOINT_MAX_BYTES = 5 * 1024 * 1024;

export interface TerminalHistoryMeta {
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: string;
  checkpointedAt: string;
  /** The `SpawnOptions.command` the pane was launched with, if any — used to
   * recognize a resumable Claude Code session on cold restore. */
  sessionCommand?: string;
}

export interface TerminalHistoryCheckpoint {
  /** `SerializeAddon` ANSI reconstruction of the terminal's last screen. */
  scrollback: string;
  cwd: string;
  cols: number;
  rows: number;
}

/**
 * On-disk scrollback + metadata for daemon-hosted terminals, so a pane
 * reopened after its daemon died or was restarted can show its last screen
 * and reopen in its last working directory (issue-driven "cold restore").
 *
 * One directory per terminal under `<bandHome>/terminal-history/`, named by
 * `encodeURIComponent(terminalId)` since a terminalId could in principle
 * contain characters invalid in a path segment. Only an explicit
 * `TerminalPool.kill` / `killWorkspace` removes a session's directory (the
 * tab or workspace is actually gone); any other way a PTY ends — a natural
 * shell exit, a daemon crash, or `killAll` during a daemon restart — leaves
 * it in place so the next spawn for that terminalId can restore it.
 */
export class TerminalHistoryManager {
  constructor(private readonly historyDir: string) {}

  private sessionDir(terminalId: string): string {
    return join(this.historyDir, encodeURIComponent(terminalId));
  }

  readMeta(terminalId: string): TerminalHistoryMeta | null {
    return readJson<TerminalHistoryMeta>(join(this.sessionDir(terminalId), "meta.json"));
  }

  readCheckpoint(terminalId: string): TerminalHistoryCheckpoint | null {
    return readJson<TerminalHistoryCheckpoint>(
      join(this.sessionDir(terminalId), "checkpoint.json"),
    );
  }

  /**
   * Async: called from the PTY output hot path (`TerminalPool.onData`), so
   * this must never block the daemon's single event loop the way the
   * synchronous `fs` calls it replaced (`writeFileSync`/`renameSync`) would —
   * a slow or networked filesystem could otherwise delay every other
   * terminal's output delivery, the exact regression issue #676 fixed for a
   * different code path.
   */
  async writeMeta(terminalId: string, meta: TerminalHistoryMeta): Promise<void> {
    await writeJson(this.sessionDir(terminalId), "meta.json", meta);
  }

  async writeCheckpoint(terminalId: string, checkpoint: TerminalHistoryCheckpoint): Promise<void> {
    const serialized = JSON.stringify(checkpoint);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > CHECKPOINT_MAX_BYTES) {
      log.warn({ terminalId, bytes }, "terminal history checkpoint too large; skipping this write");
      return;
    }
    await writeJson(this.sessionDir(terminalId), "checkpoint.json", checkpoint, serialized);
  }

  /** Drop a terminal's saved history: its tab or workspace was actually closed or deleted. */
  removeSession(terminalId: string): void {
    try {
      rmSync(this.sessionDir(terminalId), { recursive: true, force: true });
    } catch (err) {
      log.warn({ err, terminalId }, "failed to remove terminal history directory");
    }
  }

  /**
   * Drop every saved session whose last known `workspaceId` is `workspaceId`
   * — used when a workspace is deleted. Scans the whole history directory
   * rather than the pool's live reverse index, which by then may already be
   * missing terminals that exited (and were never explicitly killed) before
   * the workspace was removed.
   */
  removeSessionsForWorkspace(workspaceId: string): void {
    let names: string[];
    try {
      names = readdirSync(this.historyDir);
    } catch {
      return;
    }
    for (const name of names) {
      const dir = join(this.historyDir, name);
      const meta = readJson<TerminalHistoryMeta>(join(dir, "meta.json"));
      if (meta?.workspaceId !== workspaceId) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        log.warn({ err, dir }, "failed to remove terminal history directory");
      }
    }
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic tmp+rename write, mode 0600, mirroring `daemon-server.ts`'s `writePrivateFile`. */
async function writeJson(
  dir: string,
  name: string,
  value: unknown,
  serialized?: string,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, serialized ?? JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    log.warn({ err, dir, name }, "failed to write terminal history file");
  }
}
