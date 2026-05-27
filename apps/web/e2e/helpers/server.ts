import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

const PROJECT_ROOT = join(import.meta.dirname, "../..");
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, "src/server/infra/db/migrations");

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

/**
 * Recursively remove a tmp home directory created with `createTmpHome()`.
 *
 * Use this in every `afterAll` instead of a bare `rmSync(tmpHome, {
 * recursive: true, force: true })`. The `maxRetries`/`retryDelay` options
 * are Node's documented escape hatch for the `ENOTEMPTY` race that fires
 * when the server process's background subprocesses (du, branch-status
 * pollers, SQLite WAL flushers) are still writing to the tree as we
 * walk it bottom-up — see flake reports on issue #508 and the matching
 * resources / cache-eviction afterAll failures. `rmSync`'s recursive
 * walker retries on `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`, and
 * `EPERM`, so 10 × 100 ms gives ~1 s of headroom — well within the
 * window for `du` to wrap up on a small fixture but short enough that a
 * truly stuck cleanup still fails fast.
 */
export function cleanupTmpHome(tmpHome: string): void {
  rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle({ client: sqlite });
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
    // The production bundle runs under Node (see apps/web/README.md) and
    // uses Node's built-in `node:sqlite` for storage. Vitest integration
    // tests use the same spawn pattern via `tests/helpers/server-runtime.ts`.
    //
    // `detached: true` puts the child in its own process group. The
    // server spawns grandchildren (`du` for resource accounting, `git`
    // for the branch-status poller, terminal PTYs, …) and a plain
    // `child.kill('SIGTERM')` only signals the direct child — the
    // grandchildren are re-parented to init and keep writing to the
    // tmp home as we try to `rmSync` it, producing the `ENOTEMPTY`
    // race documented on the cleanup helper above. Putting the child
    // in its own group lets us signal the WHOLE TREE via the negative
    // pid trick in `close()` below.
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
      detached: true,
    });

    let stderr = "";
    let settled = false;

    // Signal the whole process group, not just the direct child, so
    // grandchildren spawned by the server (du, git, terminal PTYs,
    // language servers) are torn down before `rmSync(tmpHome)` runs.
    // `process.kill(-pgid, signal)` with a NEGATIVE pid targets the
    // group. Falls back to a plain `child.kill` if the pid is missing
    // (process already exited / never started). Wrapped in try/catch:
    // a benign ESRCH means "group already gone" — fine to ignore.
    const killGroup = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      try {
        if (typeof pid === "number") process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        // group already torn down
      }
    };

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
              killGroup("SIGTERM");
              // Hard backstop: if the group hasn't drained in 5 s,
              // escalate to SIGKILL so test teardown can't hang
              // forever waiting on a stuck PTY or language server.
              setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
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
        killGroup("SIGTERM");
        reject(new Error(`Server did not start within 15 s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}
