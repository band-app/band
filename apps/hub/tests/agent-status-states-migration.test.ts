import { cpSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";

const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const MIGRATION = "20261012190000_agent_status_states";

interface StatusView {
  agent: { status: string } | null;
  tabStatuses?: Record<string, string>;
}

// Migrations before the agent status states one, then rows with the old
// `needs_attention` and `waiting` values, then the rest and a real boot.
const TOKEN = "agent-status-states-migration-secret";
let home: string;
let server: ServerHandle;
const dbPath = () => join(home, ".band", "band.db");

beforeAll(async () => {
  home = createTmpHome("band-agent-status-states-migration-");
  seedSettings(home, { tokenSecret: TOKEN });

  const before = join(home, "migrations-before");
  cpSync(migrationsDir, before, { recursive: true });
  const names = readdirSync(before).filter((n) => /^\d/.test(n));
  expect(names).toContain(MIGRATION);
  for (const name of names.filter((n) => n >= MIGRATION)) {
    rmSync(join(before, name), { recursive: true });
  }

  const sqlite = new DatabaseSync(dbPath());
  migrate(drizzle({ client: sqlite }), { migrationsFolder: before });
  sqlite.exec(`
    INSERT INTO worktree_statuses (worktree_id, repo, branch, worktree_path, agent_name, agent_status, updated_at) VALUES
      ('r-attn', 'r', 'attn', '/nowhere/attn', 'claude-code', 'needs_attention', 1),
      ('r-wait', 'r', 'wait', '/nowhere/wait', 'claude-code', 'waiting', 1),
      ('r-work', 'r', 'work', '/nowhere/work', 'claude-code', 'working', 1);
    INSERT INTO worktree_status_sources (worktree_id, source_id, status, updated_at) VALUES
      ('r-attn', 'chat:a', 'needs_attention', 1),
      ('r-wait', 'chat:b', 'waiting', 1),
      ('r-work', 'chat:c', 'working', 1);
  `);
  sqlite.close();

  server = await startServer({ remoteHost: false, tmpHome: home });
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function statusOf(worktreeId: string): Promise<StatusView | null> {
  const res = await trpcQuery(server.url, "statuses.get", { worktreeId }, TOKEN);
  expect(res.status).toBe(200);
  return trpcData<StatusView | null>(res);
}

describe("agent status states migration", () => {
  it("maps needs_attention to done and waiting to idle in worktree_statuses", async () => {
    expect((await statusOf("r-attn"))?.agent?.status).toBe("done");
    expect((await statusOf("r-wait"))?.agent?.status).toBe("idle");
  });

  it("leaves a working row as the boot reset leaves it (idle, since no agent runs)", async () => {
    expect((await statusOf("r-work"))?.agent?.status).toBe("idle");
  });

  it("maps the needs_attention source row to done and leaves no old value", async () => {
    await server.close({ keepTerminalDaemon: true });
    const sqlite = new DatabaseSync(dbPath(), { readOnly: true });
    try {
      const rows = sqlite
        .prepare("SELECT source_id, status FROM worktree_status_sources ORDER BY source_id")
        .all();
      // The boot reset drops source rows that are not done or failed, so the
      // waiting row (now idle) and the working row are gone. The done one stays.
      expect(rows).toEqual([{ source_id: "chat:a", status: "done" }]);
    } finally {
      sqlite.close();
    }
  });
});
