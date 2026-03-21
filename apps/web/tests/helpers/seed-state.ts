import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../../src/lib/db/schema";

const migrationsFolder = join(import.meta.dirname, "../../src/lib/db/migrations");

interface WorktreeData {
  branch: string;
  path: string;
  head?: string;
}

interface ProjectData {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees?: WorktreeData[];
  label?: string;
}

interface StateData {
  projects: ProjectData[];
}

export function seedState(tmpHome: string, state: StateData): void {
  const bandDir = join(tmpHome, ".band");
  mkdirSync(bandDir, { recursive: true });

  const sqlite = new Database(join(bandDir, "band.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

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

  sqlite.close();
}
