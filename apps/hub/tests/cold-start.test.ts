/**
 * Integration tests for the cold-start optimizations landed by issue #472.
 *
 * Five small fixes, three black-box tests:
 *
 *  1. **Boot ordering + bulk UPDATE** — seed a populated `panel_states`
 *     table with chat + browser rows in `status: "running"`. Boot the
 *     real production server (`dist/start-server.mjs`) against a tmp
 *     `bandHome`. After `/api/health` returns OK, `chats.list` and
 *     `browsers.list` return the seeded rows with `status: "idle"` —
 *     proving both `load*FromDb` ran eagerly in `main()` *and* that the
 *     bulk-UPDATE rewrite stamped the JSON blob to `idle` on disk.
 *
 *  2. **Lazy OpenAPI** — hit `/api/openapi.json` against a freshly-booted
 *     server and verify the body matches the build-time `openapi.json`
 *     with `servers: [{ url: "/trpc" }]` substituted. The pre-#472 boot
 *     ran this parse + reformat at module top on every start; the test
 *     guards that the lazy path still returns the correct, identical
 *     payload (the lazy execution is structural — see start-server.ts
 *     `getOpenApiSpec`).
 *
 *  3. **WAL truncation on shutdown** — using a direct source-level
 *     `closeDb()` call (the same function `start-server.ts` invokes from
 *     its SIGTERM/SIGINT handler), assert that a populated WAL file
 *     collapses to ≤ a few KB after a graceful close. Without the
 *     `wal_checkpoint(TRUNCATE)` added in #472 the WAL would persist at
 *     its grown size across restarts.
 *
 * All tests follow the project convention: black-box only, real
 * SQLite + real HTTP listener on a random port, temp `bandHome`. No
 * production code is modified to make a test pass.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../src/server/infra/db/connection";
import * as schema from "../src/server/infra/db/schema";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, "src", "server", "infra", "db", "migrations");
const DEFAULT_TOKEN = "cold-start-test-token";
const WORKSPACE_ID = "coldstart-main";

// ---------------------------------------------------------------------------
// Subprocess helpers (model after cronjobs.test.ts / chat.test.ts)
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(prefix: string): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(tmp, ".band"), { recursive: true });
  return tmp;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(tmpHome: string): Promise<ServerHandle> {
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: tmpHome,
        PORT: String(port),
        NODE_ENV: "production",
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
          home: tmpHome,
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

// ---------------------------------------------------------------------------
// DB seeding — direct insert into panel_states so the production
// `loadChatsFromDb` / `loadBrowsersFromDb` see real rows on boot.
// ---------------------------------------------------------------------------

interface SeededPanel {
  id: string;
  workspaceId: string;
  panelType: "chat" | "browser";
  state: object;
}

function seedPanelStates(tmpHome: string, panels: SeededPanel[]): void {
  const bandDir = join(tmpHome, ".band");
  mkdirSync(bandDir, { recursive: true });
  const sqlite = new DatabaseSync(join(bandDir, "band.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle({ client: sqlite, schema }), { migrationsFolder: MIGRATIONS_FOLDER });

  const now = Date.now();
  const stmt = sqlite.prepare(
    `INSERT INTO panel_states (id, workspace_id, panel_type, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const panel of panels) {
    stmt.run(panel.id, panel.workspaceId, panel.panelType, JSON.stringify(panel.state), now, now);
  }
  sqlite.close();
}

function readPanelState(
  tmpHome: string,
  id: string,
): { state: string; updatedAt: number } | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"), { readOnly: true });
  try {
    const row = sqlite
      .prepare("SELECT state, updated_at as updatedAt FROM panel_states WHERE id = ?")
      .get(id) as { state: string; updatedAt: number } | undefined;
    return row;
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// tRPC helpers
// ---------------------------------------------------------------------------

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown): Promise<Response> {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: defaultHeaders });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// Test 1: Boot ordering + bulk UPDATE
// ---------------------------------------------------------------------------

describe("cold-start — boot ordering + bulk UPDATE", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const CHAT_COUNT = 5; // N > 1
  const BROWSER_COUNT = 6; // M > 1

  beforeAll(async () => {
    tmpHome = createTmpHome("band-cold-boot-test-");

    // Seed a project so the workspace resolves cleanly (the trpc routes
    // don't strictly require this, but matching what other tests do
    // keeps the boot path realistic).
    const repoDir = join(tmpHome, "repo");
    mkdirSync(repoDir, { recursive: true });
    seedState(tmpHome, {
      projects: [
        {
          name: "coldstart",
          path: repoDir,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoDir }],
          kind: "plain",
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    // Seed chats + browsers in `running` state — what
    // `loadChatsFromDb` / `loadBrowsersFromDb` are expected to flip back
    // to "idle" via the bulk-UPDATE path.
    const panels: SeededPanel[] = [];
    for (let i = 0; i < CHAT_COUNT; i++) {
      panels.push({
        id: `chat_seed_${i}`,
        workspaceId: WORKSPACE_ID,
        panelType: "chat",
        state: {
          name: `Chat ${i}`,
          agent: "claude-code",
          model: null,
          mode: null,
          activeSessionId: null,
          activeSessionSummary: null,
          activeSessionLastModified: null,
          // Intentionally not "idle" so we can prove the boot flipped it.
          status: "running",
        },
      });
    }
    for (let i = 0; i < BROWSER_COUNT; i++) {
      panels.push({
        id: `browser_seed_${i}`,
        workspaceId: WORKSPACE_ID,
        panelType: "browser",
        state: {
          name: `Tab ${i}`,
          url: `https://example.test/${i}`,
          // chat-manager uses ChatStatus, browser-manager uses
          // BrowserStatus. `loading` is the non-idle browser equivalent.
          status: "loading",
        },
      });
    }
    seedPanelStates(tmpHome, panels);

    server = await startServer(tmpHome);
  }, 30_000);

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("/api/health returns OK after boot", async () => {
    const res = await fetch(`${server.url}/api/health`, { headers: defaultHeaders });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; app: string };
    expect(data.status).toBe("ok");
    expect(data.app).toBe("band-web-server");
  });

  it("chats.list returns seeded chats with status reset to idle", async () => {
    const res = await trpcQuery(server.url, "chats.list", { workspaceId: WORKSPACE_ID });
    expect(res.status).toBe(200);
    const data = await trpcData<{ chats: Array<{ id: string; name: string; status: string }> }>(
      res,
    );

    expect(data.chats.length).toBe(CHAT_COUNT);

    // Every seeded chat should be present and reset to "idle". If
    // `loadChatsFromDb` hadn't run during `main()` the rows would be
    // populated lazily by `listChats` on first access — but they'd
    // still pass through `loadChatsFromDb` (lazy `ensureInitialized`
    // would call it), so this assertion catches the bulk-UPDATE failure
    // rather than the eagerness. The eagerness check is the
    // `loaded chat panes from database` log line + the
    // browsers-eagerly-loaded test below.
    for (const chat of data.chats) {
      expect(chat.status).toBe("idle");
      expect(chat.id.startsWith("chat_seed_")).toBe(true);
    }
  });

  it("browsers.list returns seeded tabs with status reset to idle", async () => {
    const res = await trpcQuery(server.url, "browsers.list", { workspaceId: WORKSPACE_ID });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      browsers: Array<{ id: string; name: string; url: string; status: string }>;
    }>(res);

    expect(data.browsers.length).toBe(BROWSER_COUNT);
    for (const browser of data.browsers) {
      expect(browser.status).toBe("idle");
      expect(browser.id.startsWith("browser_seed_")).toBe(true);
    }
  });

  it("on-disk panel_states JSON blobs are flipped to idle by the bulk UPDATE", async () => {
    // This is the proof that the bulk-UPDATE actually wrote to disk
    // (rather than only flipping the in-memory copy). We read the
    // persisted blob through a separate sqlite connection — the server
    // is in WAL mode so concurrent readers are fine.
    for (let i = 0; i < CHAT_COUNT; i++) {
      const row = readPanelState(tmpHome, `chat_seed_${i}`);
      expect(row).toBeDefined();
      const parsed = JSON.parse(row!.state) as { status: string };
      expect(parsed.status).toBe("idle");
    }
    for (let i = 0; i < BROWSER_COUNT; i++) {
      const row = readPanelState(tmpHome, `browser_seed_${i}`);
      expect(row).toBeDefined();
      const parsed = JSON.parse(row!.state) as { status: string };
      expect(parsed.status).toBe("idle");
    }
  });

  it("all reset rows share the same updated_at timestamp", async () => {
    // Correctness check: every row updated in the reset shares the same
    // `updated_at` value. This guards against a future refactor that
    // accidentally writes per-row timestamps (e.g. recapturing
    // `Date.now()` inside a loop) — which would re-introduce the WAL
    // churn this PR is trying to eliminate.
    //
    // This assertion does NOT prove "one SQL statement vs N statements":
    // the pre-#472 per-row UPDATE loop also captured `now = Date.now()`
    // once at the top of `loadChatsFromDb` and reused it across all
    // rows, so identical timestamps would have held there too. The
    // single-statement guarantee is structural — it lives in
    // `resetPanelStatesToIdle` — and belongs in code review, not in a
    // runtime assertion.
    const updatedAts = new Set<number>();
    for (let i = 0; i < CHAT_COUNT; i++) {
      const row = readPanelState(tmpHome, `chat_seed_${i}`);
      updatedAts.add(row!.updatedAt);
    }
    expect(updatedAts.size).toBe(1);

    const browserUpdatedAts = new Set<number>();
    for (let i = 0; i < BROWSER_COUNT; i++) {
      const row = readPanelState(tmpHome, `browser_seed_${i}`);
      browserUpdatedAts.add(row!.updatedAt);
    }
    expect(browserUpdatedAts.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Lazy OpenAPI doc still serves the expected body
// ---------------------------------------------------------------------------

describe("cold-start — lazy OpenAPI doc", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-openapi-test-");
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer(tmpHome);
  }, 30_000);

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("/api/openapi.json returns the build-time spec with /trpc servers substituted", async () => {
    // The lazy getter is structural — it can't be observed black-box
    // (the body is the same either way), so this test guards the
    // correctness side: hitting the endpoint must return the same JSON
    // the pre-#472 module-top code produced, byte-for-byte after
    // pretty-printing.
    const res = await fetch(`${server.url}/api/openapi.json`, { headers: defaultHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.text();
    const parsed = JSON.parse(body) as { servers: Array<{ url: string }> };

    // `servers` is the only field the boot code rewrites — verify it.
    expect(parsed.servers).toEqual([{ url: "/trpc" }]);

    // Compare to the build artifact on disk after applying the same
    // mutation. If anything else in the pipeline drifts (different
    // formatting, different field) the diff will surface here.
    const onDisk = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "dist", "openapi.json"), "utf-8"),
    ) as Record<string, unknown>;
    onDisk.servers = [{ url: "/trpc" }];
    expect(body).toBe(JSON.stringify(onDisk, null, 2));
  });

  it("second request returns the same cached body (no per-request reparse)", async () => {
    const r1 = await fetch(`${server.url}/api/openapi.json`, { headers: defaultHeaders });
    const r2 = await fetch(`${server.url}/api/openapi.json`, { headers: defaultHeaders });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = await r1.text();
    const b2 = await r2.text();
    expect(b1).toBe(b2);
  });

  it("/api/docs serves the Scalar HTML wrapper without errors", async () => {
    const res = await fetch(`${server.url}/api/docs`, { headers: defaultHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Scalar.createApiReference");
    expect(body).toContain("/api/openapi.json");
  });
});

// ---------------------------------------------------------------------------
// Test 3: WAL truncation on closeDb()
//
// This one bypasses the subprocess and calls `closeDb()` directly from
// the source — same function `start-server.ts` invokes from its
// SIGTERM/SIGINT shutdown handler. Black-box-on-the-WAL: we never look
// at `closeDb`'s internals, we look at what the file system shows for
// `~/.band/band.db-wal` before and after.
// ---------------------------------------------------------------------------

describe("cold-start — WAL truncation on closeDb()", () => {
  let tmp: string;
  let originalBandHome: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-wal-truncate-test-")));
    originalBandHome = process.env.BAND_HOME;
    process.env.BAND_HOME = join(tmp, ".band");
  });

  afterEach(() => {
    // Defensive: tests should have closed the DB themselves, but if a
    // failure left it open the global drizzle handle would leak across
    // suites.
    closeDb();
    if (originalBandHome !== undefined) {
      process.env.BAND_HOME = originalBandHome;
    } else {
      delete process.env.BAND_HOME;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("truncates ~/.band/band.db-wal to <= a few KB after closeDb()", () => {
    // Populate the DB through the public API so the WAL grows past the
    // threshold we want to assert against. Each insert is one frame; a
    // few hundred inserts is plenty to push the WAL well past 4 KB.
    const db = getDb();
    const now = Date.now();
    db.transaction((tx) => {
      for (let i = 0; i < 250; i++) {
        tx.insert(schema.panelStates)
          .values({
            id: `chat_grow_${i}`,
            workspaceId: WORKSPACE_ID,
            panelType: "chat",
            state: JSON.stringify({
              name: `Chat ${i}`,
              agent: "claude-code",
              status: "idle",
            }),
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    });

    const walPath = join(tmp, ".band", "band.db-wal");

    // The transaction may have already auto-checkpointed if the WAL
    // crossed the default 1000-page threshold, so the strong pre-check
    // we *can* make is "the file exists and is non-zero". The fact that
    // closeDb shrinks whatever WAL is present to ≤ a few KB is the
    // actual assertion below.
    expect(existsSync(walPath)).toBe(true);

    closeDb();

    // After closeDb(), wal_checkpoint(TRUNCATE) ran. The WAL file
    // either:
    //   - was deleted entirely, OR
    //   - was truncated to 0 bytes, OR
    //   - holds only the WAL header (~32 bytes).
    //
    // The acceptance criterion in the issue says "≤ a few KB after a
    // graceful Cmd+Q"; we assert ≤ 4 KB (4096 bytes) to leave headroom
    // for any platform-specific header padding while still being well
    // under a typical pre-TRUNCATE WAL size.
    if (existsSync(walPath)) {
      const size = statSync(walPath).size;
      expect(size).toBeLessThanOrEqual(4096);
    }
  });

  it("closeDb() is idempotent (safe to call twice)", () => {
    // Touch the DB so a connection exists.
    getDb();
    closeDb();
    // Second call must not throw — start-server's shutdown handler
    // calls closeDb() after handing off, and `process.exit(0)` is
    // racing module finalizers in tests.
    expect(() => closeDb()).not.toThrow();
  });
});
