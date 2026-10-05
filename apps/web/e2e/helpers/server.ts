import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { LISTENING_BANNER } from "../../../hub/tests/helpers/server";
import { stopTerminalDaemon } from "../../../hub/tests/helpers/terminal-daemon";
import { ACP_STUB_AGENT_PATH } from "./acp-stub";

// The server under test is the hub bundle (`apps/hub/dist/start-server.mjs`);
// it serves the UI from `apps/web/dist/client` by default.
const HUB_ROOT = join(import.meta.dirname, "../../../hub");
const MIGRATIONS_FOLDER = join(HUB_ROOT, "src/server/infra/db/migrations");

export interface ServerHandle {
  url: string;
  home: string;
  /**
   * Stop the server, then the terminal daemon it may have launched for
   * `home` (see `stopTerminalDaemon`). Pass `keepTerminalDaemon` to model a
   * server restart, where the daemon and its shells must survive.
   */
  close: (opts?: { keepTerminalDaemon?: boolean }) => Promise<void>;
  /**
   * Restart the way a desktop relaunch does: stop this server, leave the
   * terminal daemon (and every shell in it) running, and boot a new server on
   * the same home, port and env. The port matters: the page's sockets
   * reconnect to the original URL.
   */
  restart: () => Promise<ServerHandle>;
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

interface SeedRepo {
  name: string;
  path: string;
  defaultBranch: string;
  label?: string;
  // `name` is the immutable worktree identity — defaults to `branch` (the
  // create-time invariant). Pass it explicitly to simulate a worktree
  // whose git branch was switched after creation.
  worktrees: { name?: string; branch: string; path: string }[];
}

export function seedState(tmpHome: string, state: { repos: SeedRepo[] }): void {
  // Write state.json for backwards compatibility
  writeFileSync(join(tmpHome, ".band", "state.json"), JSON.stringify(state));

  // Also seed the SQLite DB so loadState() finds the repos
  const dbPath = join(tmpHome, ".band", "band.db");
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle({ client: sqlite });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  for (let i = 0; i < state.repos.length; i++) {
    const repo = state.repos[i];
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO repos (name, path, default_branch, label, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(repo.name, repo.path, repo.defaultBranch, repo.label ?? null, i);

    for (const wt of repo.worktrees) {
      sqlite
        .prepare(
          `INSERT INTO worktrees (repo_name, name, branch, path)
           VALUES (?, ?, ?, ?)`,
        )
        .run(repo.name, wt.name ?? wt.branch, wt.branch, wt.path);
    }
  }
  sqlite.close();
}

/**
 * Marks a seeded worktree as asleep (an ephemeral worker stored it and exited, plan step 3.5),
 * or waking when `waking` is set. The UI only reads the row, so no worker is involved.
 */
export function seedSleepingWorktree(
  tmpHome: string,
  row: { worktreeId: string; repo: string; name: string; path: string; waking?: boolean },
): void {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    sqlite
      .prepare(
        `INSERT INTO worktree_sleep (worktree_id, host_id, repo, name, branch, worktree_path,
           base_sha, snapshot_sha, ref, store, session_ids, waking_since, created_at)
         VALUES (?, 'h-seeded', ?, ?, ?, ?, 'a', 'a', 'refs/heads/band/wip/x', 'remote', '[]', ?, ?)`,
      )
      .run(
        row.worktreeId,
        row.repo,
        row.name,
        row.name,
        row.path,
        row.waking ? Date.now() : null,
        Date.now(),
      );
  } finally {
    sqlite.close();
  }
}

/**
 * Delete a seeded repo and its worktrees from the DB, the way removing
 * them while Band was closed leaves it. Call it while the server is stopped.
 */
export function removeSeededRepo(tmpHome: string, name: string): void {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    sqlite.prepare("DELETE FROM worktrees WHERE repo_name = ?").run(name);
    sqlite.prepare("DELETE FROM repos WHERE name = ?").run(name);
  } finally {
    sqlite.close();
  }
}

/**
 * Delete every client-state row (the UI state the dashboard keeps on the
 * server: center tabs, panel widths, label memory, …). Before client state
 * moved to the server it lived in each browser context's localStorage, so a
 * spec whose tests share one server got fresh UI state per test for free.
 * Call this in `beforeEach` to keep that: one test's collapsed sidebar or
 * open tabs must not show up in the next test's new browser context. Safe
 * while the server runs, which reads the table on every request.
 */
export function resetClientState(tmpHome: string): void {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    sqlite.exec("DELETE FROM client_state");
  } finally {
    sqlite.close();
  }
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
  opts: { tmpHome?: string; env?: Record<string, string>; port?: number } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  // Allow pinning the port so a test can restart the server on the SAME
  // address — the client's `EventSource` auto-reconnects to the original
  // URL, so a fresh random port would orphan the connection. Used by the
  // stuck-thinking-indicator reconnect spec, which kills and re-spawns the
  // server to model a lost `task-completed` (in-memory buffer wiped on
  // restart). Defaults to an OS-assigned random port for isolation.
  const port = opts.port ?? (await getRandomPort());

  return new Promise((resolve, reject) => {
    // The production bundle runs under Node (see apps/hub/README.md) and
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
      cwd: HUB_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        // Every coding agent runs as an ACP subprocess (issue #648). Point
        // them all at the scripted stub so no spec starts a real `claude` /
        // `codex` adapter: the boot-time model refresh probes every
        // configured agent, chat or not. Specs that script replies pass
        // `acpStubEnv()` from `./acp-stub` in `opts.env`.
        BAND_TEST_ACP_AGENT: ACP_STUB_AGENT_PATH,
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

    const close = async (closeOpts?: { keepTerminalDaemon?: boolean }) => {
      await new Promise<void>((r) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          r();
          return;
        }
        // Hard backstop: if the group hasn't drained in 5 s,
        // escalate to SIGKILL so test teardown can't hang
        // forever waiting on a stuck PTY or language server.
        const fallback = setTimeout(() => killGroup("SIGKILL"), 5_000);
        child.on("exit", () => {
          clearTimeout(fallback);
          r();
        });
        killGroup("SIGTERM");
      });
      if (!closeOpts?.keepTerminalDaemon) await stopTerminalDaemon(home);
    };

    let stdout = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString();
      // The server moves to the next port when `PORT` is taken by the time it
      // binds (`listenWithFallback`), so use the port its banner reports.
      const boundPort = LISTENING_BANNER.exec(stdout)?.[1];
      if (boundPort) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${boundPort}`,
          home,
          close,
          restart: async () => {
            await close({ keepTerminalDaemon: true });
            return startServer({ ...opts, tmpHome: home, port: Number(boundPort) });
          },
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
