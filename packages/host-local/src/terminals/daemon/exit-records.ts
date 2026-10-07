import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TerminalExitEvent } from "../terminal-pool";

/**
 * Exits of shells that ended while no server was connected to their daemon.
 * A daemon with no shell and no server exits at once, so the record is a file
 * in `<runDir>/exits/`, one per terminal, written by the daemon and read once
 * by the next server (`drainExitRecords`). Only daemons started with
 * `--record-exits` write them: the worker does, the hub's own daemon does not.
 */
const EXITS_DIR = "exits";

function exitsDir(runDir: string): string {
  return join(runDir, EXITS_DIR);
}

export function writeExitRecord(runDir: string, event: TerminalExitEvent): void {
  const dir = exitsDir(runDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${encodeURIComponent(event.terminalId)}.json`);
  // Through a rename, so a reader never sees half a record.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(event), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Reads and deletes every record. A record that does not parse is deleted without being reported. */
export function drainExitRecords(runDir: string): TerminalExitEvent[] {
  const dir = exitsDir(runDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const events: TerminalExitEvent[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const event = JSON.parse(readFileSync(file, "utf8")) as TerminalExitEvent;
      if (typeof event.terminalId === "string" && typeof event.worktreeId === "string") {
        events.push(event);
      }
    } catch {
      // Unreadable: nothing to report.
    }
    try {
      unlinkSync(file);
    } catch {
      // Another reader took it.
    }
  }
  return events;
}
