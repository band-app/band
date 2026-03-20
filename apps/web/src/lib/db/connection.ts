import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { bandHome } from "../state";
import * as schema from "./schema";

const migrationsFolder = join(import.meta.dirname, "migrations");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: InstanceType<typeof Database> | null = null;

export function getDb() {
  if (_db) return _db;

  const home = bandHome();
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, "band.db");

  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");

  _db = drizzle(_sqlite, { schema });
  migrate(_db, { migrationsFolder });
  migrateStateJson(_db, home);

  return _db;
}

function migrateStateJson(db: NonNullable<typeof _db>, home: string): void {
  const file = join(home, "state.json");
  if (!existsSync(file)) return;

  const existing = db.select().from(schema.projects).get();
  if (existing) return;

  try {
    const data = readFileSync(file, "utf-8");
    const state = JSON.parse(data);
    if (!state.projects?.length) return;

    db.transaction((tx) => {
      for (let i = 0; i < state.projects.length; i++) {
        const project = state.projects[i];
        tx.insert(schema.projects)
          .values({
            name: project.name,
            path: project.path,
            defaultBranch: project.defaultBranch,
            label: project.label ?? null,
            sortOrder: i,
          })
          .run();

        for (const wt of project.worktrees ?? []) {
          tx.insert(schema.worktrees)
            .values({
              projectName: project.name,
              branch: wt.branch,
              path: wt.path,
              head: wt.head ?? null,
            })
            .run();
        }
      }
    });

    renameSync(file, `${file}.bak`);
  } catch {
    // If JSON is invalid or migration fails, skip silently
  }
}

export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}
