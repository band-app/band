// The `BAND_TEST_HOST` switch (plan step 2.6). With `local` (the default) the
// suites run workspaces on the hub's own machine. With `remote-loopback`
// `startServer` also starts a real `band-worker` against the test server and
// moves the workspaces the test seeded onto that host, so the same assertions
// run through `RemoteHost`, the link and the worker.
//
// The worker is on the same machine, so it sees the same temp dirs the test
// wrote. Its root is the OS temp dir, which holds every path a test seeds.
// The hub must not see them: `worker-fs-guard.mjs` is preloaded into the hub
// process and fails any fs call or child process cwd under a worker-owned
// path, as the hub would on a real worker's disk (see `workerGuardEnv`).
//
// A test that cannot run on a worker (it reaches into the hub's own terminal
// daemon, the hub's machine, or a path outside the temp dir) opts out with
// `startServer({ ..., remoteHost: false })`. The list
// of those files is in `docs/integration-testing.md`.

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { waitFor } from "./wait-for";

type TestHostMode = "local" | "remote-loopback";

function readMode(): TestHostMode {
  const value = process.env.BAND_TEST_HOST ?? "local";
  if (value !== "local" && value !== "remote-loopback") {
    throw new Error(`BAND_TEST_HOST must be "local" or "remote-loopback", got "${value}"`);
  }
  return value;
}

export const isRemoteLoopback = readMode() === "remote-loopback";

const GUARD_PRELOAD = join(import.meta.dirname, "worker-fs-guard.mjs");

function guardFiles(home: string): { paths: string; violations: string } {
  return {
    paths: join(home, ".band-test-worker-paths.json"),
    violations: join(home, ".band-test-worker-violations.jsonl"),
  };
}

/**
 * Environment for the hub process in remote-loopback mode: preloads the guard
 * and tells it where the worker-owned paths and the violation log are.
 * `guardFiles` start empty, so the hub may read anything until workspaces move.
 */
export function workerGuardEnv(home: string): Record<string, string> {
  const files = guardFiles(home);
  writeFileSync(files.paths, "[]");
  writeFileSync(files.violations, "");
  const preload = `--import ${pathToFileURL(GUARD_PRELOAD).href}`;
  return {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" "),
    BAND_TEST_WORKER_PATHS_FILE: files.paths,
    BAND_TEST_WORKER_VIOLATIONS_FILE: files.violations,
  };
}

/** Throws when the hub touched a worker path during the test. Call after the hub has stopped. */
export function assertNoWorkerPathAccess(home: string): void {
  const file = guardFiles(home).violations;
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) return;
  const seen = new Set<string>();
  const report: string[] = [];
  for (const line of lines) {
    const v = JSON.parse(line) as { api: string; path: string; stack?: string };
    const key = `${v.api} ${v.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    report.push(`${key}\n${v.stack ?? ""}`);
  }
  throw new Error(
    `The hub read or ran something under a path the worker owns. A hub service must reach a remote workspace through its Host.\n${report.join("\n")}`,
  );
}

const WORKER_BIN = join(import.meta.dirname, "../../../worker/bin/band-worker.mjs");

interface LoopbackWorker {
  hostId: string;
  close(): Promise<void>;
}

interface WorkerTarget {
  url: string;
  home: string;
  /** The environment the test gave the hub. Agents run on the worker, so it needs the same (stub agent paths and scenarios). */
  env?: Record<string, string>;
}

function adminToken(home: string): string {
  const settings = JSON.parse(readFileSync(join(home, ".band", "settings.json"), "utf8")) as {
    tokenSecret?: string;
  };
  if (!settings.tokenSecret) throw new Error(`no tokenSecret in ${home}/.band/settings.json`);
  return settings.tokenSecret;
}

async function trpc<T>(
  target: WorkerTarget,
  kind: "query" | "mutation",
  procedure: string,
  input?: unknown,
): Promise<T> {
  const token = adminToken(target.home);
  const url =
    kind === "query" && input !== undefined
      ? `${target.url}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${target.url}/trpc/${procedure}`;
  const res = await fetch(url, {
    method: kind === "query" ? "GET" : "POST",
    headers: { "content-type": "application/json", Cookie: `band_token=${token}` },
    body: kind === "mutation" ? JSON.stringify(input ?? {}) : undefined,
  });
  if (!res.ok) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const fallback = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(fallback);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Register a worker with the hub at `target`, start the real `band-worker`
 * binary on this machine, and wait for the hub to list its host as online.
 * Everything the worker owns (state, HOME) lives in its own temp dir.
 */
export async function startLoopbackWorker(target: WorkerTarget): Promise<LoopbackWorker> {
  const tmpRoot = realpathSync(tmpdir());
  const workerHome = realpathSync(mkdtempSync(join(tmpRoot, "band-loopback-worker-")));
  mkdirSync(join(workerHome, ".band"), { recursive: true });

  const issued = await trpc<{ token: string; hostId: string }>(
    target,
    "mutation",
    "tokens.issueWorkerBootstrap",
    { hostName: "Loopback worker", labels: ["loopback"] },
  );

  const child = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      target.url,
      "--token",
      issued.token,
      "--root",
      tmpRoot,
      "--state-dir",
      join(workerHome, "state"),
    ],
    {
      env: {
        ...process.env,
        ...target.env,
        // The hub's HOME, so what the worker reads from `~/.claude` is what the
        // test wrote there. Its own state stays in `workerHome`.
        HOME: target.home,
        BAND_HOME: join(workerHome, ".band"),
        BAND_TERMINAL_DAEMON: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (d) => {
    output += d;
  });
  child.stderr?.on("data", (d) => {
    output += d;
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));

  const close = async () => {
    await stopProcess(child);
    rmSync(workerHome, { recursive: true, force: true, maxRetries: 10 });
  };

  try {
    await waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(
            `band-worker exited with ${await exited} before it was online\n${output}`,
          );
        }
        const { hosts } = await trpc<{ hosts: Array<{ id: string; status: string }> }>(
          target,
          "query",
          "hosts.list",
        );
        return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
      },
      { label: "loopback worker online", timeoutMs: 20_000, intervalMs: 100 },
    );
  } catch (err) {
    await close();
    throw err;
  }
  return { hostId: issued.hostId, close };
}

/**
 * Move every workspace in the hub's database onto `hostId`: its worktree rows, and
 * the projects' checkout paths on that host (the same paths, because the
 * worker shares this machine's disk). Then lists the worktree paths for the
 * guard, so the hub can no longer read them. A workspace at the project root
 * stays readable, because that path is also the hub's own copy of the project.
 */
export function moveSeededWorkspacesToHost(home: string, hostId: string): void {
  const workerPaths: string[] = [];
  const sqlite = new DatabaseSync(join(home, ".band", "band.db"));
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO project_hosts (project_name, host_id, path) SELECT name, ?, path FROM projects",
      )
      .run(hostId);
    // Rows of an earlier worker count too: a test that restarts the hub gets a new worker.
    sqlite.prepare("UPDATE worktrees SET host_id = ? WHERE host_id <> ?").run(hostId, hostId);
    // A project's own path is the hub's copy of it, which the hub keeps on a
    // real worker too. Only checkouts that are not a project root are off limits.
    const rows = sqlite
      .prepare(
        "SELECT path FROM worktrees WHERE host_id = ? AND path NOT IN (SELECT path FROM projects)",
      )
      .all(hostId) as Array<{
      path: string;
    }>;
    workerPaths.push(...rows.map((row) => row.path));
  } finally {
    sqlite.close();
  }
  // The worker's own directories sit under its root, the OS temp dir.
  const root = realpathSync(tmpdir());
  for (const dir of [".band-worktrees", ".band-uploads", ".band-shared"]) {
    workerPaths.push(join(root, dir));
  }
  writeFileSync(guardFiles(home).paths, JSON.stringify([...new Set(workerPaths)]));
}
