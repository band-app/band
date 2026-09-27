/**
 * Read a Chrome SQLite DB (Cookies, History) from a private copy.
 *
 * Chrome holds its DBs open and writes through a WAL or rollback journal,
 * so the DB and those files are copied into a private temp dir (mode 0700)
 * and read from there. The copy is deleted before `withDbSnapshot` returns.
 *
 * A copy taken while Chrome is writing can come out torn. SQLite then
 * reports the copy as busy, locked or malformed, and that surfaces here as
 * `ChromeDataLockedError`, so the caller stops before it writes anything.
 */

import { chmod, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export class ChromeDataLockedError extends Error {
  constructor() {
    super(
      "Google Chrome is using this profile's data, so Band couldn't read it. Quit Google Chrome completely and try again.",
    );
    this.name = "ChromeDataLockedError";
  }
}

/** SQLITE_BUSY, SQLITE_LOCKED, SQLITE_CORRUPT, SQLITE_NOTADB (primary codes). */
const LOCK_OR_TORN_CODES = new Set([5, 6, 11, 26]);
const LOCK_FS_CODES = new Set(["EBUSY", "EAGAIN", "EDEADLK"]);

/** True for errors that mean "Chrome is holding or writing this DB". */
export function isLockedDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { errcode, code } = err as { errcode?: unknown; code?: unknown };
  // node:sqlite reports the extended result code; the low byte is the primary one.
  if (typeof errcode === "number" && LOCK_OR_TORN_CODES.has(errcode & 0xff)) return true;
  return typeof code === "string" && LOCK_FS_CODES.has(code);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Copy `dbPath` (plus its WAL / rollback journal) into a fresh private temp
 * dir, open the copy, and pass it to `read`. Async so a multi-MB copy
 * doesn't stall the Electron main process.
 */
export async function withDbSnapshot<T>(dbPath: string, read: (db: DatabaseSync) => T): Promise<T> {
  // Loaded here, not at module top: these modules are imported at
  // main-process boot, and a failure to load `node:sqlite` must only fail
  // the import.
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "band-chrome-import-"));
  try {
    const copyPath = join(dir, basename(dbPath));
    // The copies are owner-only whatever the source's mode.
    await copyFile(dbPath, copyPath);
    await chmod(copyPath, 0o600);
    for (const suffix of ["-wal", "-journal"]) {
      if (!(await exists(dbPath + suffix))) continue;
      await copyFile(dbPath + suffix, copyPath + suffix);
      await chmod(copyPath + suffix, 0o600);
    }
    // Read-write on purpose: the copy is private, and SQLite needs to write
    // a `-shm` file to open a WAL-mode DB.
    const db = new DatabaseSync(copyPath, { readBigInts: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch (err) {
    if (isLockedDbError(err)) throw new ChromeDataLockedError();
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
