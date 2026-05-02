import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { bandHome } from "../state";
import * as schema from "./schema";

const migrationsFolder = join(import.meta.dirname, "migrations");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database | null = null;

export function getDb() {
  if (_db) return _db;

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
