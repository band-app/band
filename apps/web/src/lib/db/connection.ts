import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { bandHome } from "../state";
import * as schema from "./schema";

const migrationsFolder = join(import.meta.dirname, "migrations");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: DatabaseSync | null = null;

export function getDb() {
  if (_db) return _db;

  const home = bandHome();
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, "band.db");

  _sqlite = new DatabaseSync(dbPath);
  _sqlite.exec("PRAGMA journal_mode = WAL");
  _sqlite.exec("PRAGMA foreign_keys = ON");

  _db = drizzle({ client: _sqlite, schema });
  migrate(_db, { migrationsFolder });

  return _db;
}

export function closeDb(): void {
  if (_sqlite) {
    // Truncate the WAL on graceful shutdown. Without this, `band.db-wal`
    // grows unbounded across restarts (3.9 MB on the user captured in
    // issue #472 — larger than the 2.5 MB main DB) and the next
    // `new DatabaseSync()` has to replay every WAL frame before the
    // server can serve traffic. `TRUNCATE` writes any unflushed frames
    // into the main DB and then truncates the WAL file to zero bytes
    // (or a tiny header) so the next boot picks up a clean baseline.
    //
    // Wrapped in try/catch so a checkpoint failure (busy writer, locked
    // database, disk full) never prevents the close from running —
    // leaving the handle open on shutdown is strictly worse than a
    // slightly stale WAL.
    try {
      _sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // best-effort
    }
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}
