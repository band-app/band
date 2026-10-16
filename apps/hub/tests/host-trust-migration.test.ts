import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const TRUST_MIGRATION = "20261016220249_host_trust";

// Runs every migration before the host trust one against a temp DB, seeds hosts, then applies
// the rest. A server boot applies all migrations at once, so no public surface can stop one step
// short to seed an install from before trust levels. Never touches the real ~/.band.
describe("host trust migration", () => {
  let tmp = "";
  let sqlite: DatabaseSync;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "band-host-trust-migration-"));
    sqlite = new DatabaseSync(join(tmp, "band.db"));
    sqlite.exec("PRAGMA foreign_keys = ON");
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("makes every existing host standard and leaves new hosts unset", () => {
    const before = join(tmp, "migrations-before");
    cpSync(migrationsDir, before, { recursive: true });
    const names = readdirSync(before).filter((n) => /^\d/.test(n));
    expect(names).toContain(TRUST_MIGRATION);
    for (const name of names.filter((n) => n >= TRUST_MIGRATION)) {
      rmSync(join(before, name), { recursive: true });
    }
    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder: before });
    sqlite.exec(`
      INSERT INTO hosts (id, name, mode, status, created_at) VALUES ('h-mac', 'Mac', 'attached', 'online', 1);
      INSERT INTO hosts (id, name, mode, status, created_at) VALUES ('h-eph', 'Eph', 'ephemeral', 'offline', 2);
    `);

    migrate(db, { migrationsFolder: migrationsDir });

    expect(sqlite.prepare("SELECT id, trust FROM hosts ORDER BY id").all()).toEqual([
      { id: "h-eph", trust: "standard" },
      { id: "h-mac", trust: "standard" },
      { id: "local", trust: "standard" },
    ]);
    sqlite.exec(`INSERT INTO hosts (id, name, created_at) VALUES ('h-new', 'New', 3)`);
    expect(sqlite.prepare("SELECT trust FROM hosts WHERE id = 'h-new'").get()).toEqual({
      trust: null,
    });
  });
});
