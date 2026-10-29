import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Exits of children that ended while no server was connected to their daemon.
 * A daemon with nothing to host and no server exits at once, so the record is
 * a file in `<runDir>/exits/`, one per child, written by the daemon and read
 * once by the next server (`drainExitRecords`).
 */
const EXITS_DIR = "exits";

function exitsDir(runDir: string): string {
  return join(runDir, EXITS_DIR);
}

export function writeExitRecord(runDir: string, key: string, record: unknown): void {
  const dir = exitsDir(runDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${encodeURIComponent(key)}.json`);
  // Through a rename, so a reader never sees half a record.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Reads and deletes every record. A record that does not parse, or that
 * `isRecord` rejects, is deleted without being reported.
 */
export function drainExitRecords<T>(runDir: string, isRecord: (value: unknown) => value is T): T[] {
  const dir = exitsDir(runDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isRecord(value)) records.push(value);
    } catch {
      // Unreadable: nothing to report.
    }
    try {
      unlinkSync(file);
    } catch {
      // Another reader took it.
    }
  }
  return records;
}
