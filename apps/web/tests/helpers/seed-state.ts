import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import * as schema from "../../src/lib/db/schema";

const migrationsFolder = join(import.meta.dirname, "../../src/lib/db/migrations");

interface WorktreeData {
  branch: string;
  path: string;
  head?: string;
  pinned?: boolean;
}

interface ProjectData {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees?: WorktreeData[];
  label?: string;
  kind?: "git" | "plain";
}

interface StateData {
  projects: ProjectData[];
}

export function seedState(tmpHome: string, state: StateData): void {
  const bandDir = join(tmpHome, ".band");
  mkdirSync(bandDir, { recursive: true });

  const sqlite = new DatabaseSync(join(bandDir, "band.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = drizzle({ client: sqlite, schema });
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
          kind: project.kind ?? "git",
        })
        .run();

      for (const wt of project.worktrees ?? []) {
        tx.insert(schema.worktrees)
          .values({
            projectName: project.name,
            branch: wt.branch,
            path: wt.path,
            head: wt.head ?? null,
            pinned: wt.pinned ?? false,
          })
          .run();
      }
    }
  });

  sqlite.close();
}

export interface WorkspaceStatusData {
  workspaceId: string;
  project: string;
  branch: string;
  worktreePath: string;
  agentName?: string;
  agentStatus?: string;
  agentLastActivity?: string;
  agentSummary?: string;
  codingAgentId?: string;
}

export function seedWorkspaceStatuses(tmpHome: string, statuses: WorkspaceStatusData[]): void {
  const bandDir = join(tmpHome, ".band");
  mkdirSync(bandDir, { recursive: true });

  const sqlite = new DatabaseSync(join(bandDir, "band.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder });

  const now = Date.now();
  db.transaction((tx) => {
    for (const s of statuses) {
      tx.insert(schema.workspaceStatuses)
        .values({
          workspaceId: s.workspaceId,
          project: s.project,
          branch: s.branch,
          worktreePath: s.worktreePath,
          agentName: s.agentName ?? "claude-code",
          agentStatus: s.agentStatus ?? "waiting",
          agentLastActivity: s.agentLastActivity ?? "",
          agentSummary: s.agentSummary ?? null,
          codingAgentId: s.codingAgentId ?? null,
          updatedAt: now,
        })
        .run();
    }
  });

  sqlite.close();
}

export function seedSettings(tmpHome: string, settings: object): void {
  const bandDir = join(tmpHome, ".band");
  mkdirSync(bandDir, { recursive: true });
  writeFileSync(join(bandDir, "settings.json"), JSON.stringify(settings, null, 2), "utf-8");
}
