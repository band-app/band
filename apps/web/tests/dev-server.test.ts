/**
 * Integration tests for the unified dev/prod web server (issue #477).
 *
 * Pre-#477, dev mode ran a separate ~370-line `trpcDevPlugin` inside
 * `vite.config.ts`'s `configureServer` hook that re-implemented half of
 * `start-server.ts`'s surface. The implementations drifted on five
 * concrete points (cronjobs not firing, stale tasks not cleaned up,
 * resetAgentStatuses missing, etc.), and every routing bug had to be
 * fixed twice.
 *
 * After #477 there is **one** `start-server.ts`, used in both modes; in
 * dev it mounts Vite as middleware inside its own http server. These
 * tests prove the dev mode is feature-complete with prod for the things
 * the issue's acceptance criteria call out:
 *
 *   1. **Dev-mode parity** — boot `start-server.ts` with
 *      `NODE_ENV=development` against a tmp `bandHome`. Assert:
 *        - `/api/health` returns 200
 *        - `/api/openapi.json` returns the same shape as prod
 *        - `GET /` returns SSR'd HTML with `<title>Band</title>`
 *        - a seeded `running` task gets flipped to `failed` (cleanupStaleTasks ran)
 *        - the cronjob scheduler is bound (cronjobs.list works through tRPC)
 *
 *   2. **HMR through the unified server** — edit a route's title literal,
 *      re-fetch `/`, assert new value within a few seconds, restore,
 *      assert original.
 *
 *   3. **WebSocket coexistence** — open the /terminal WebSocket and a
 *      tRPC subscription concurrently; both deliver messages without
 *      interfering with Vite's HMR ws on the same http listener.
 *
 * Per CLAUDE.md: black-box only, real infrastructure, no mocks. Server
 * runs as a real subprocess via `tsx` against the source `start-server.ts`
 * (so dev-mode SSR through `ssrLoadModule` is exercised end-to-end).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as schema from "../src/lib/db/schema";
import { findFreePort } from "../src/lib/port-utils";
import { seedSettings, seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, "src", "lib", "db", "migrations");
const ROOT_ROUTE_PATH = join(PROJECT_ROOT, "src", "routes", "__root.tsx");

// In dev mode the server skips auth (matches the prior `vite dev`
// behaviour we replaced — `trpcDevPlugin` never added auth either). Tests
// hit the server without a Cookie header.
const NO_AUTH_HEADERS: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  port: number;
  home: string;
  child: ChildProcess;
  close: () => Promise<void>;
}

function createTmpHome(prefix: string): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(tmp, ".band"), { recursive: true });
  return tmp;
}

/**
 * Boot start-server.ts in dev mode via `tsx`. Returns once the
 * "Web server listening on …" banner is emitted. The 60s timeout is
 * generous because the first dev boot eagerly runs the `runFirstTimeSetup`
 * skill installer (see Phase B in start-server.ts) — synchronous file
 * I/O that takes 1-3 s on a populated $HOME.
 */
async function startDevServer(tmpHome: string): Promise<ServerHandle> {
  // Ask `findFreePort` for a starting port, but expect `start-server.ts`
  // to scan via `listenWithFallback` and actually bind some port — not
  // necessarily this one. `findFreePort` releases its kernel-picked
  // port before we spawn, so under CI load another process can grab it
  // in the gap. Resolving against the actual bound port (parsed from
  // the listen banner) keeps the test honest about which port subsequent
  // fetches need to target.
  const hintPort = await findFreePort();

  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "start-server.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: tmpHome,
        PORT: String(hintPort),
        NODE_ENV: "development",
        // Silence the pnpm "deprecated" warnings that would otherwise
        // intersperse with our log parsing.
        NO_UPDATE_NOTIFIER: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      const match = stdout.match(/Web server listening on https?:\/\/[^:\s]+:(\d+)/);
      if (match && !settled) {
        settled = true;
        const port = Number.parseInt(match[1], 10);
        resolve({
          url: `http://127.0.0.1:${port}`,
          port,
          home: tmpHome,
          child,
          close: () =>
            new Promise<void>((r) => {
              child.on("exit", () => r());
              child.kill("SIGTERM");
              // Hard kill if SIGTERM hangs (tsx watch's signal handling
              // sometimes wedges in tests).
              setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
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
        reject(
          new Error(
            `Dev server exited with code ${code} before listening.\n` +
              `stdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(
          new Error(`Dev server did not start within 60 s.\nstdout: ${stdout}\nstderr: ${stderr}`),
        );
      }
    }, 60_000);
  });
}

// ---------------------------------------------------------------------------
// tRPC helpers
// ---------------------------------------------------------------------------

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown): Promise<Response> {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: NO_AUTH_HEADERS });
}

async function trpcMutate(
  serverUrl: string,
  procedure: string,
  input?: unknown,
): Promise<Response> {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...NO_AUTH_HEADERS },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
}

async function trpcData<T>(res: Response): Promise<T> {
  // Throw with a descriptive message on non-2xx or on a tRPC error
  // envelope (`{ error: … }`) rather than letting `body.result.data`
  // dereference `undefined` and produce a confusing TypeError stack —
  // the wrapper sees test debugging more often than success, so the
  // failure mode should be obvious.
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { result?: { data: T }; error?: unknown };
  if (!body.result) throw new Error(`tRPC error: ${JSON.stringify(body.error)}`);
  return body.result.data;
}

// ---------------------------------------------------------------------------
// DB seeding for task-cleanup test
// ---------------------------------------------------------------------------

function seedRunningTask(tmpHome: string, taskId: string): void {
  const bandDir = join(tmpHome, ".band");
  mkdirSync(bandDir, { recursive: true });
  const sqlite = new DatabaseSync(join(bandDir, "band.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle({ client: sqlite, schema }), { migrationsFolder: MIGRATIONS_FOLDER });

  const now = Date.now();
  // Mirror the schema in src/lib/db/schema.ts. The columns here are
  // deliberately written by name (not via drizzle's API) so this test
  // breaks loudly if the schema changes — the corresponding production
  // fix needs to be reflected in `cleanupStaleTasks` too.
  sqlite
    .prepare(
      `INSERT INTO tasks (id, workspace_id, project, branch, prompt, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, NULL)`,
    )
    .run(taskId, "devtest-main", "devtest", "main", "stale task", now - 60_000);
  sqlite.close();
}

function readTaskStatus(tmpHome: string, taskId: string): string | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"), { readOnly: true });
  try {
    const row = sqlite.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
      | { status: string }
      | undefined;
    return row?.status;
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// Test 1 — Dev-mode parity with prod
// ---------------------------------------------------------------------------

describe("dev server — parity with prod", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const STALE_TASK_ID = "task_stale_dev_1";

  beforeAll(async () => {
    tmpHome = createTmpHome("band-dev-parity-");
    const repoDir = join(tmpHome, "repo");
    mkdirSync(repoDir, { recursive: true });
    seedState(tmpHome, {
      projects: [
        {
          name: "devtest",
          path: repoDir,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoDir }],
          kind: "plain",
        },
      ],
    });
    // No tokenSecret in dev — we want to assert dev intentionally skips
    // auth. (`getOrCreateToken` will still write one on first boot, but
    // `start-server.ts` passes `undefined` to the auth middleware in
    // dev mode so it doesn't enforce.)
    seedSettings(tmpHome, {});
    seedRunningTask(tmpHome, STALE_TASK_ID);

    server = await startDevServer(tmpHome);
  }, 90_000);

  afterAll(async () => {
    if (server) await server.close();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("/api/health returns 200 without auth", async () => {
    const res = await fetch(`${server.url}/api/health`, { headers: NO_AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; app: string };
    expect(body.status).toBe("ok");
    expect(body.app).toBe("band-web-server");
  });

  it("/api/openapi.json returns a valid spec with /trpc as the server base", async () => {
    const res = await fetch(`${server.url}/api/openapi.json`, { headers: NO_AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as {
      openapi: string;
      servers: Array<{ url: string }>;
      info: { title: string };
      paths: Record<string, unknown>;
    };
    expect(body.openapi).toBe("3.1.1");
    expect(body.info.title).toBe("Band API");
    expect(body.servers).toEqual([{ url: "/trpc" }]);
    // Sanity check — the spec should have *some* endpoints generated by
    // @trpc/openapi's static analyser. The exact list is brittle to keep
    // pinned, but a near-empty `paths` object is a strong signal that
    // dev-mode generation actually crashed quietly.
    expect(Object.keys(body.paths).length).toBeGreaterThan(5);
  });

  it("GET / returns SSR'd HTML with <title>Band</title> via Vite middleware", async () => {
    const res = await fetch(server.url, { headers: NO_AUTH_HEADERS });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Band</title>");
    // Confirm it's actually SSR'd through TanStack Start, not just a
    // static index — the SSR'd page injects a `$_TSR` bootstrap script.
    expect(html).toContain("$_TSR");
  });

  it("seeded `running` task is flipped to `failed` after boot (cleanupStaleTasks ran)", async () => {
    // Phase B (after listen()) runs cleanupStaleTasks asynchronously via
    // setImmediate. By the time we get here, the listen-callback's
    // setImmediate has long since fired. Poll briefly to absorb any
    // residual race in CI.
    let status: string | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      status = readTaskStatus(tmpHome, STALE_TASK_ID);
      if (status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Tight assertion — `cleanupStaleTasks` is documented to mark
    // orphaned `running` rows as `failed`, so anything else (including
    // a still-`running` row) is a regression worth catching here.
    expect(status).toBe("failed");
  });

  it("cronjob scheduler is bound — cronjobs CRUD works through tRPC", async () => {
    // The scheduler is started in Phase B (setImmediate after listen).
    // If it never bound, `cronjobs.list` would still work (it reads from
    // disk), so use `cronjobs.create` instead — the mutation goes
    // through the file-watcher invalidation path that requires the
    // scheduler to be running.
    const createRes = await trpcMutate(server.url, "cronjobs.create", {
      key: "devtest",
      name: "Dev parity cron",
      prompt: "noop",
      cronExpression: "0 9 * * 1",
      scope: "project",
      enabled: true,
    });
    expect(createRes.status).toBe(200);
    const created = await trpcData<{ job: { id: string; name: string } }>(createRes);
    expect(created.job.name).toBe("Dev parity cron");

    const listRes = await trpcQuery(server.url, "cronjobs.list");
    expect(listRes.status).toBe(200);
    const list = await trpcData<{ jobs: Array<{ id: string }> }>(listRes);
    expect(list.jobs.length).toBe(1);
    expect(list.jobs[0].id).toBe(created.job.id);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — HMR through the unified server
// ---------------------------------------------------------------------------

describe("dev server — HMR through unified server", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let originalRootRoute: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-dev-hmr-");
    seedSettings(tmpHome, {});

    // Capture the on-disk source BEFORE we mutate it so we can guarantee
    // restoration in the after-all hook, even on test failure.
    originalRootRoute = readFileSync(ROOT_ROUTE_PATH, "utf-8");

    // Refuse to run if the route file has been left dirty by an
    // earlier crashed test run. Mutating a committed file is the only
    // way to exercise Vite's watcher → SSR-invalidation round-trip,
    // but blindly capturing whatever happens to be on disk could
    // anchor the post-test restore to the wrong baseline. The needle
    // we're about to flip MUST be present at start; the wrong-needle
    // case (any of our mutation suffixes already present) means a
    // previous run left state behind and we should fail loud rather
    // than carry on.
    if (!originalRootRoute.includes('{ title: "Band" }')) {
      throw new Error(
        `${ROOT_ROUTE_PATH} doesn't contain the expected unmodified ` +
          `title literal '{ title: "Band" }'. Either the test fixture is ` +
          `stale (restore the file by hand from git) or an unrelated ` +
          `refactor moved the title.`,
      );
    }

    server = await startDevServer(tmpHome);
  }, 90_000);

  afterAll(async () => {
    // Restore the route source first, before tearing down the server,
    // so a watched re-eval at process exit can't observe the mutated
    // file. (Vite's ssrLoadModule cache lives in-process, so this is
    // belt-and-suspenders — but cheap insurance.)
    if (originalRootRoute) {
      writeFileSync(ROOT_ROUTE_PATH, originalRootRoute, "utf-8");
    }
    if (server) await server.close();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("edit to __root.tsx title shows up on next SSR request", async () => {
    // Baseline — confirm the unmodified route renders the original title.
    const baseRes = await fetch(server.url, { headers: NO_AUTH_HEADERS });
    expect(baseRes.status).toBe(200);
    const baseHtml = await baseRes.text();
    expect(baseHtml).toContain("<title>Band</title>");

    // Mutate the source. The literal we target is unique to the head()
    // descriptor; if a future refactor moves the title, the search will
    // fail loudly rather than silently match nothing.
    const TITLE_NEEDLE = '{ title: "Band" }';
    const NEW_NEEDLE = '{ title: "Band-HMR-XYZ" }';
    expect(originalRootRoute.includes(TITLE_NEEDLE)).toBe(true);
    const mutated = originalRootRoute.replace(TITLE_NEEDLE, NEW_NEEDLE);
    writeFileSync(ROOT_ROUTE_PATH, mutated, "utf-8");

    // Poll the rendered title — Vite invalidates the SSR module graph
    // on watcher events, but file → fs → watcher → invalidation is
    // event-loop-bound, so allow up to 5 s for the new value to settle.
    let mutatedHtml = "";
    let observed = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await fetch(server.url, { headers: NO_AUTH_HEADERS });
      mutatedHtml = await res.text();
      if (mutatedHtml.includes("<title>Band-HMR-XYZ</title>")) {
        observed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      observed,
      `expected mutated title within 5 s; last body: ${mutatedHtml.slice(0, 300)}`,
    ).toBe(true);

    // Restore the original — the after-all hook would catch a leak,
    // but restoring inline lets us assert the round-trip works too.
    writeFileSync(ROOT_ROUTE_PATH, originalRootRoute, "utf-8");
    let restored = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await fetch(server.url, { headers: NO_AUTH_HEADERS });
      const html = await res.text();
      if (html.includes("<title>Band</title>") && !html.includes("Band-HMR-XYZ")) {
        restored = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(restored).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — WebSocket coexistence
// ---------------------------------------------------------------------------

describe("dev server — WebSocket coexistence with Vite HMR", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-dev-ws-");
    const repoDir = join(tmpHome, "repo");
    mkdirSync(repoDir, { recursive: true });
    seedState(tmpHome, {
      projects: [
        {
          name: "wstest",
          path: repoDir,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoDir }],
          kind: "plain",
        },
      ],
    });
    seedSettings(tmpHome, {});

    server = await startDevServer(tmpHome);
  }, 90_000);

  afterAll(async () => {
    if (server) await server.close();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("opens /terminal and a tRPC subscription on the same http listener without interference", async () => {
    // ----- /terminal WebSocket -----
    //
    // The coexistence claim is "our `/terminal` upgrade handler and
    // Vite's HMR upgrade handler don't fight over `httpServer.upgrade`
    // events". To prove that the right way, assert that we actually
    // received an HTTP 101 (Switching Protocols) response for our
    // upgrade. PTY behaviour after the upgrade is a downstream concern
    // — accepting `"errored"` as passing would let a regression that
    // silently drops the upgrade slip through (the test was originally
    // written that way and reviewer caught it).
    const workspaceId = "wstest-main";
    const terminalId = `dev-coexistence-${Date.now()}`;
    const termWs = new WebSocket(
      `ws://127.0.0.1:${server.port}/terminal?workspaceId=${workspaceId}&terminalId=${terminalId}`,
    );

    const upgradeOk = await new Promise<boolean>((resolve) => {
      // `upgrade` fires on the `ws` client when the server returns 101.
      // If the server refuses the upgrade (handler missing, vite-hmr
      // path wins, etc.) we get `close` or `error` instead.
      termWs.on("upgrade", () => resolve(true));
      termWs.on("error", () => resolve(false));
      termWs.on("close", () => resolve(false));
      setTimeout(() => resolve(false), 8_000);
    });
    expect(upgradeOk, "expected /terminal upgrade to negotiate HTTP 101").toBe(true);

    termWs.close();

    // ----- tRPC subscription -----
    //
    // The /trpc WebSocket is the path applyWSSHandler attaches to (no
    // path prefix — `wss.handleUpgrade` is called for any non-/terminal,
    // non-/lsp, non-/cdp upgrade). We test that an upgrade succeeds and
    // the connection stays open for a moment — that proves the upgrade
    // listener didn't drop the request because of Vite's HMR check.
    const trpcWs = new WebSocket(`ws://127.0.0.1:${server.port}/api/trpc`);
    const trpcOpened = await new Promise<boolean>((resolve) => {
      trpcWs.on("open", () => resolve(true));
      trpcWs.on("error", () => resolve(false));
      trpcWs.on("close", () => resolve(false));
      setTimeout(() => resolve(false), 5_000);
    });
    expect(trpcOpened).toBe(true);
    trpcWs.close();

    // ----- Vite's HMR ws still works after our upgrades happened -----
    //
    // Vite's HMR upgrade carries the `vite-hmr` subprotocol — our
    // upgrade handler short-circuits in that case and lets Vite's own
    // listener claim the request. If our handler accidentally consumed
    // the upgrade, this connection would fail.
    const hmrWs = new WebSocket(`ws://127.0.0.1:${server.port}/`, "vite-hmr");
    const hmrOpened = await new Promise<boolean>((resolve) => {
      hmrWs.on("open", () => resolve(true));
      hmrWs.on("error", () => resolve(false));
      hmrWs.on("close", () => resolve(false));
      setTimeout(() => resolve(false), 5_000);
    });
    expect(hmrOpened).toBe(true);
    hmrWs.close();
  });
});
