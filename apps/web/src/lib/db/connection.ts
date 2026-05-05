import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { bandHome } from "../state";
import * as schema from "./schema";

// `bun:sqlite` and `drizzle-orm/bun-sqlite` only resolve under the Bun
// runtime. Importing them statically would crash anything that touches
// this module under Node (vitest, type-checks, IDE tooling) — even
// though those callers never open the DB. We require them lazily so
// only `getDb()` callers — i.e. the spawned Bun server — ever resolve
// the Bun-only specifiers.
const lazyRequire = createRequire(import.meta.url);

const migrationsFolder = join(import.meta.dirname, "migrations");

let _db: BunSQLiteDatabase<typeof schema> | null = null;
let _sqlite: Database | null = null;

export function getDb() {
  if (_db) return _db;

  const { Database } = lazyRequire("bun:sqlite") as typeof import("bun:sqlite");
  const { drizzle } = lazyRequire(
    "drizzle-orm/bun-sqlite",
  ) as typeof import("drizzle-orm/bun-sqlite");
  const { migrate } = lazyRequire(
    "drizzle-orm/bun-sqlite/migrator",
  ) as typeof import("drizzle-orm/bun-sqlite/migrator");

  const home = bandHome();
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, "band.db");

  _sqlite = new Database(dbPath, { create: true });
  _sqlite.run("PRAGMA journal_mode = WAL");
  _sqlite.run("PRAGMA foreign_keys = ON");

  _db = drizzle(_sqlite, { schema });
  migrate(_db, { migrationsFolder });

  return _db;
}

export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}
