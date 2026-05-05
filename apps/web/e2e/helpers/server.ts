import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const PROJECT_ROOT = join(import.meta.dirname, "../..");
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, "src/lib/db/migrations");

export interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

export function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-e2e-test-")));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  mkdirSync(join(bandDir, "status"), { recursive: true });
  return tmp;
}

interface SeedProject {
  name: string;
  path: string;
  defaultBranch: string;
  label?: string;
  worktrees: { branch: string; path: string }[];
}

export function seedState(tmpHome: string, state: { projects: SeedProject[] }): void {
  // Write state.json for backwards compatibility
  writeFileSync(join(tmpHome, ".band", "state.json"), JSON.stringify(state));

  // Also seed the SQLite DB so loadState() finds the projects
  const dbPath = join(tmpHome, ".band", "band.db");
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  for (let i = 0; i < state.projects.length; i++) {
    const project = state.projects[i];
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO projects (name, path, default_branch, label, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(project.name, project.path, project.defaultBranch, project.label ?? null, i);

    for (const wt of project.worktrees) {
      sqlite
        .prepare(
          `INSERT INTO worktrees (project_name, branch, path)
           VALUES (?, ?, ?)`,
        )
        .run(project.name, wt.branch, wt.path);
    }
  }
  sqlite.close();
}

export function seedSettings(tmpHome: string, settings: object): void {
  const bandDir = join(tmpHome, ".band");
  mkdirSync(bandDir, { recursive: true });
  writeFileSync(join(bandDir, "settings.json"), JSON.stringify(settings, null, 2), "utf-8");
}

export function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    // The production bundle runs under Node (see apps/web/README.md). It
    // imports better-sqlite3, a Node-ABI native module loaded at startup.
    // Vitest integration tests use the same approach via
    // `tests/helpers/server-runtime.ts`.
    const child = spawn("node", ["dist/start-server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home,
          close: () =>
            new Promise<void>((r) => {
              child.on("exit", () => r());
              child.kill("SIGTERM");
            }),
        });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited with code ${code} before listening.\nstderr: ${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Server did not start within 15 s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}
