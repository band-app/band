// Integration tests for issue #416 — worktree task cleanup and time-based
// prune. Both behaviours are exercised end-to-end through the running web
// server so the production code path is what actually wipes the rows:
//
//   1. `worktrees.remove` is invoked over tRPC; we then inspect the SQLite
//      DB the server wrote to and assert the worktree's task rows are gone.
//   2. The prune sweep runs synchronously on server boot
//      (`startTaskPruneScheduler` in start-server.ts). We seed task rows
//      with timestamps older than the 30-day retention window, start the
//      server, then read the DB to confirm only the recent rows survived.
//      A second boot against the same DB asserts the prune is idempotent.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_RETENTION_MS } from "../src/server/infra/db/queries/tasks";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome as createCanonicalTmpHome,
  type ServerHandle,
  startServer as startCanonicalServer,
} from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { removeTmpHome } from "./helpers/tmp-home";

const DEFAULT_TOKEN = "task-cleanup-test-token";
const MIGRATIONS_FOLDER = join(
  import.meta.dirname,
  "..",
  "src",
  "server",
  "infra",
  "db",
  "migrations",
);

// ---------------------------------------------------------------------------
// Server lifecycle (mirrors the pattern used in `tasks-crud.test.ts`)
// ---------------------------------------------------------------------------

function createTmpHome(prefix: string): string {
  return createCanonicalTmpHome(prefix);
}

function startServer(opts: { tmpHome: string }): Promise<ServerHandle> {
  return startCanonicalServer({ tmpHome: opts.tmpHome });
}

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
}

// ---------------------------------------------------------------------------
// DB helpers — same shape as the helpers in `tasks-crud.test.ts`.
// ---------------------------------------------------------------------------

function openDb(tmpHome: string): DatabaseSync {
  const dbPath = join(tmpHome, ".band", "band.db");
  mkdirSync(join(tmpHome, ".band"), { recursive: true });
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS_FOLDER });
  return sqlite;
}

interface SeedTask {
  id: string;
  worktreeId: string;
  repo: string;
  branch: string;
  prompt: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number | null;
}

function seedTask(sqlite: DatabaseSync, task: SeedTask): void {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO tasks (id, worktree_id, repo, branch, prompt, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.worktreeId,
      task.repo,
      task.branch,
      task.prompt,
      task.status,
      task.startedAt,
      task.completedAt ?? null,
    );
}

function listTaskIds(sqlite: DatabaseSync): string[] {
  const rows = sqlite.prepare("SELECT id FROM tasks ORDER BY id").all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function listWorktreeTaskIds(sqlite: DatabaseSync, worktreeId: string): string[] {
  const rows = sqlite
    .prepare("SELECT id FROM tasks WHERE worktree_id = ? ORDER BY id")
    .all(worktreeId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

function createGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# Test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

// ---------------------------------------------------------------------------
// 1. worktrees.remove deletes the worktree's task rows
// ---------------------------------------------------------------------------

describe("worktree task cleanup on removal (issue #416)", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-task-cleanup-remove-");
    const repoPath = createGitRepo(tmpHome, "proj");

    // Real git worktree for the feature branch so `worktrees.remove`'s
    // background `git worktree remove --force` has something to chew on.
    git(repoPath, ["branch", "feature"]);
    git(repoPath, ["worktree", "add", join(tmpHome, "proj-feature"), "feature"]);

    seedState(tmpHome, {
      repos: [
        {
          name: "proj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: repoPath },
            {
              name: "feature",
              branch: "feature",
              path: join(tmpHome, "proj-feature"),
            },
          ],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    const now = Date.now();
    const sqlite = openDb(tmpHome);
    try {
      seedTask(sqlite, {
        id: "tsk_main_a",
        worktreeId: testWorktreeId("proj", "main"),
        repo: "proj",
        branch: "main",
        prompt: "main task 1",
        status: "completed",
        startedAt: now - 2_000,
        completedAt: now - 1_000,
      });
      seedTask(sqlite, {
        id: "tsk_main_b",
        worktreeId: testWorktreeId("proj", "main"),
        repo: "proj",
        branch: "main",
        prompt: "main task 2",
        status: "failed",
        startedAt: now - 5_000,
        completedAt: now - 4_000,
      });
      seedTask(sqlite, {
        id: "tsk_feature_a",
        worktreeId: testWorktreeId("proj", "feature"),
        repo: "proj",
        branch: "feature",
        prompt: "feature task 1",
        status: "completed",
        startedAt: now - 3_000,
        completedAt: now - 2_500,
      });
    } finally {
      sqlite.close();
    }

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("deletes the worktree's tasks and leaves other worktrees untouched", async () => {
    // Sanity-check the seed survived the server boot — `cleanupStaleTasks`
    // can flip running rows to failed, but the rows themselves must remain
    // because none of them are >30d old.
    {
      const sqlite = openDb(tmpHome);
      try {
        expect(listWorktreeTaskIds(sqlite, testWorktreeId("proj", "feature"))).toEqual([
          "tsk_feature_a",
        ]);
        expect(listWorktreeTaskIds(sqlite, testWorktreeId("proj", "main")).sort()).toEqual([
          "tsk_main_a",
          "tsk_main_b",
        ]);
      } finally {
        sqlite.close();
      }
    }

    const res = await trpcMutate(server.url, "worktrees.remove", {
      repo: "proj",
      name: "feature",
    });
    expect(res.status).toBe(200);

    const sqlite = openDb(tmpHome);
    try {
      expect(listWorktreeTaskIds(sqlite, testWorktreeId("proj", "feature"))).toEqual([]);
      // Other worktree's tasks remain untouched.
      expect(listWorktreeTaskIds(sqlite, testWorktreeId("proj", "main")).sort()).toEqual([
        "tsk_main_a",
        "tsk_main_b",
      ]);
    } finally {
      sqlite.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Auto-prune on boot deletes rows older than 30 days
// ---------------------------------------------------------------------------

describe("auto-prune tasks older than 30 days (issue #416)", () => {
  let tmpHome: string;

  beforeAll(() => {
    tmpHome = createTmpHome("band-task-cleanup-prune-");
    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
  });

  afterAll(() => {
    removeTmpHome(tmpHome);
  });

  it("removes old tasks while keeping recent ones; orphaned rows fall back to startedAt; reruns are idempotent", async () => {
    const now = Date.now();
    const old = now - TASK_RETENTION_MS - 60_000; // 30 d + 1 min old
    const recent = now - 60_000; // 1 min old

    // ── Seed the DB before the server boots ──
    {
      const sqlite = openDb(tmpHome);
      try {
        sqlite.exec("DELETE FROM tasks");
        // Old completed row — must be deleted.
        seedTask(sqlite, {
          id: "tsk_old_completed",
          worktreeId: testWorktreeId("any", "main"),
          repo: "any",
          branch: "main",
          prompt: "old completed",
          status: "completed",
          startedAt: old - 5_000,
          completedAt: old,
        });
        // Old failed row — must be deleted.
        seedTask(sqlite, {
          id: "tsk_old_failed",
          worktreeId: testWorktreeId("any", "main"),
          repo: "any",
          branch: "main",
          prompt: "old failed",
          status: "failed",
          startedAt: old - 10_000,
          completedAt: old,
        });
        // Old orphan (no completedAt) older than 30 d by startedAt — must be deleted.
        seedTask(sqlite, {
          id: "tsk_old_orphan",
          worktreeId: testWorktreeId("any", "main"),
          repo: "any",
          branch: "main",
          prompt: "abandoned",
          status: "failed",
          startedAt: old,
          completedAt: null,
        });
        // Recent completed row — must survive.
        seedTask(sqlite, {
          id: "tsk_recent_completed",
          worktreeId: testWorktreeId("any", "main"),
          repo: "any",
          branch: "main",
          prompt: "recent completed",
          status: "completed",
          startedAt: recent - 1_000,
          completedAt: recent,
        });
        // Recent orphan (no completedAt) within window by startedAt — must survive.
        seedTask(sqlite, {
          id: "tsk_recent_orphan",
          worktreeId: testWorktreeId("any", "main"),
          repo: "any",
          branch: "main",
          prompt: "recent orphan",
          status: "running",
          startedAt: recent,
          completedAt: null,
        });
      } finally {
        sqlite.close();
      }
    }

    // Wait for the Phase-B prune pass to finish writing. Issue #477
    // moved `startTaskPruneScheduler` (which runs one prune
    // synchronously on bind) out of the await-blocking boot path and
    // into a `setImmediate` after `httpServer.listen()`, so the
    // listen-banner-based readiness probe used by `startServer` can
    // return a few ms before the prune lands on disk. Poll with a
    // bounded retry budget — a real regression still fails the
    // assertion below.
    const EXPECTED_AFTER_PRUNE = ["tsk_recent_completed", "tsk_recent_orphan"] as const;
    async function waitForPrune(home: string): Promise<void> {
      let lastIds: string[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        const sqlite = openDb(home);
        try {
          lastIds = listTaskIds(sqlite).sort();
          if (
            lastIds.length === EXPECTED_AFTER_PRUNE.length &&
            lastIds.every((id, i) => id === EXPECTED_AFTER_PRUNE[i])
          ) {
            return;
          }
        } finally {
          sqlite.close();
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      // Throw with a descriptive message instead of letting the
      // assertion below collapse to a generic "arrays don't match" —
      // a silent timeout makes "prune scheduler never executed"
      // indistinguishable from "prune executed but produced the wrong
      // row set."
      throw new Error(
        `Phase-B startTaskPruneScheduler did not prune within 5 s ` +
          `(last observed task ids: [${lastIds.join(", ")}]). Regression?`,
      );
    }

    // ── First boot: the scheduler kicks off one prune pass on bind in
    //     Phase B (post-listen, via setImmediate). ──
    const server1 = await startServer({ tmpHome });
    try {
      await waitForPrune(tmpHome);
      const sqlite = openDb(tmpHome);
      try {
        expect(listTaskIds(sqlite).sort()).toEqual(["tsk_recent_completed", "tsk_recent_orphan"]);
      } finally {
        sqlite.close();
      }
    } finally {
      await server1.close();
    }

    // ── Second boot against the same DB: no rows should be deleted (idempotent). ──
    const server2 = await startServer({ tmpHome });
    try {
      await waitForPrune(tmpHome);
      const sqlite = openDb(tmpHome);
      try {
        expect(listTaskIds(sqlite).sort()).toEqual(["tsk_recent_completed", "tsk_recent_orphan"]);
      } finally {
        sqlite.close();
      }
    } finally {
      await server2.close();
    }
  });
});
