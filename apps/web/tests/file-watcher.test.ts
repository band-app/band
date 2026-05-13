// Integration tests for the FileBrowser cache-invalidation flow:
//
//   * `apps/web/src/lib/file-watcher.ts` starts a recursive `fs.watch` on
//     demand when a client subscribes to a workspace's file changes, and
//     tears it down when the last subscriber disconnects.
//   * The tRPC `workspace.fileChanges({ workspaceId })` subscription
//     forwards coalesced events to the WebSocket client.
//   * The web adapter's `subscribeFileChanges` is a thin wrapper around it.
//
// We exercise the full server pipeline by spawning the production server,
// subscribing via WebSocket for a specific workspace, mutating files on
// disk from outside the server's own mutation endpoints (the exact
// scenario issue #384 describes — terminals, IDEs, drag-drop, agents)
// and asserting that the right events arrive (and nothing leaks across
// workspaces).

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "file-watcher-test-token";

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-file-watcher-test-")));
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

async function startServer(opts: { tmpHome: string }): Promise<ServerHandle> {
  const home = opts.tmpHome;
  const port = await getRandomPort();
  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
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
      if (chunk.toString().includes("listening") && !settled) {
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

// ---------------------------------------------------------------------------
// Git helpers — used to build a realistic worktree
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
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(join(repoPath, "README.md"), "# test\n");
  writeFileSync(join(repoPath, "src", "index.ts"), 'console.log("hi");\n');
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

// ---------------------------------------------------------------------------
// WebSocket / tRPC helpers
// ---------------------------------------------------------------------------

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

interface WSMessage {
  id: number;
  jsonrpc: string;
  result?: { type: "started" | "data" | "stopped"; data?: unknown };
}

interface FileChangePayload {
  path: string;
}

function isFileChangePayload(data: unknown): data is FileChangePayload {
  if (!data || typeof data !== "object") return false;
  return typeof (data as { path?: unknown }).path === "string";
}

interface Subscription {
  ready: Promise<void>;
  fileChanges: FileChangePayload[];
  waitForFileChange: (
    pathPredicate?: (path: string) => boolean,
    timeoutMs?: number,
  ) => Promise<FileChangePayload>;
  close: () => void;
}

/**
 * Subscribe to `workspace.fileChanges` for a single workspace. The
 * resolved `ready` promise waits for the server to confirm the
 * subscription has started AND adds a grace period so the recursive
 * `fs.watch` handle is fully primed before the test touches the FS.
 * 500 ms is conservative for slow / shared CI runners — at 250 ms the
 * very first write occasionally races the kernel setting up the watch.
 */
function subscribeFileChanges(serverUrl: string, workspaceId: string): Subscription {
  const wsUrl = `${serverUrl.replace(/^http/, "ws")}/trpc`;
  const fileChanges: FileChangePayload[] = [];
  const listeners: Array<{
    predicate: (event: FileChangePayload) => boolean;
    resolve: (event: FileChangePayload) => void;
  }> = [];
  let startedResolve: () => void;
  const started = new Promise<void>((r) => {
    startedResolve = r;
  });

  const ws = new WebSocket(wsUrl, { headers: defaultHeaders });

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "subscription",
        params: { path: "workspace.fileChanges", input: { workspaceId } },
      }),
    );
  });

  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString()) as WSMessage;
    if (msg.result?.type === "started") {
      startedResolve();
      return;
    }
    if (msg.result?.type === "data" && isFileChangePayload(msg.result.data)) {
      const payload = msg.result.data;
      fileChanges.push(payload);
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i].predicate(payload)) {
          listeners[i].resolve(payload);
          listeners.splice(i, 1);
        }
      }
    }
  });

  return {
    ready: started.then(() => new Promise<void>((r) => setTimeout(r, 500))),
    fileChanges,
    waitForFileChange(pathPredicate, timeoutMs = 5_000) {
      const matches = (event: FileChangePayload) =>
        pathPredicate ? pathPredicate(event.path) : true;

      for (const event of fileChanges) {
        if (matches(event)) return Promise.resolve(event);
      }
      return new Promise<FileChangePayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = listeners.findIndex((l) => l.resolve === resolve);
          if (idx !== -1) listeners.splice(idx, 1);
          reject(
            new Error(`Timed out waiting for file-change(${pathPredicate ? "predicate" : "any"})`),
          );
        }, timeoutMs);
        listeners.push({
          predicate: matches,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
    close: () => ws.close(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("file-watcher — external file change events", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;
  let otherRepoPath: string;
  const workspaceId = "myrepo-main";

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoPath = createGitRepo(tmpHome, "myrepo");
    otherRepoPath = createGitRepo(tmpHome, "otherrepo");
    seedState(tmpHome, {
      projects: [
        {
          name: "myrepo",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
        {
          name: "otherrepo",
          path: otherRepoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: otherRepoPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("emits a file-change event when a file is created at the workspace root", async () => {
    const sub = subscribeFileChanges(server.url, workspaceId);
    try {
      await sub.ready;
      const wait = sub.waitForFileChange((p) => p === "");
      await writeFile(join(repoPath, "external.txt"), "hello\n");
      const event = await wait;
      expect(event.path).toBe("");
    } finally {
      sub.close();
    }
  });

  it("emits a file-change event when a file is created in a subdirectory", async () => {
    const sub = subscribeFileChanges(server.url, workspaceId);
    try {
      await sub.ready;
      const wait = sub.waitForFileChange((p) => p === "src");
      await writeFile(join(repoPath, "src", "added.ts"), "export {};\n");
      const event = await wait;
      expect(event.path).toBe("src");
    } finally {
      sub.close();
    }
  });

  it("emits a file-change event when a file is renamed", async () => {
    const targetDir = join(repoPath, "src");
    const before = join(targetDir, "rename-before.ts");
    const after = join(targetDir, "rename-after.ts");
    await writeFile(before, "// before\n");

    // Drain the create event before subscribing for the rename event so the
    // assertion isn't satisfied by stale traffic on the wire.
    await new Promise((r) => setTimeout(r, 400));

    const sub = subscribeFileChanges(server.url, workspaceId);
    try {
      await sub.ready;
      const wait = sub.waitForFileChange((p) => p === "src");
      await rename(before, after);
      const event = await wait;
      expect(event.path).toBe("src");
    } finally {
      sub.close();
    }
  });

  it("emits a file-change event when a directory is created and ignores it inside node_modules", async () => {
    // Create a node_modules directory first — events from inside it must be
    // suppressed so the FileBrowser isn't drowned in `pnpm install` noise.
    await mkdir(join(repoPath, "node_modules", "junk"), { recursive: true });

    const sub = subscribeFileChanges(server.url, workspaceId);
    try {
      await sub.ready;

      // 1. Visible directory creation triggers an event
      const wait = sub.waitForFileChange((p) => p === "");
      await mkdir(join(repoPath, "new-dir"));
      const event = await wait;
      expect(event.path).toBe("");

      // 2. node_modules churn does NOT trigger an event within 600ms
      await writeFile(join(repoPath, "node_modules", "junk", "lib.js"), "module.exports={};\n");
      await expect(sub.waitForFileChange((p) => p.startsWith("node_modules"), 600)).rejects.toThrow(
        /Timed out/,
      );
    } finally {
      sub.close();
    }
  });

  it("does not start a watcher for an unknown workspace", async () => {
    // Subscribing for a workspace that doesn't exist returns a silent no-op
    // — no events ever arrive. This is what protects us from runaway
    // watchers on misconfigured clients.
    const sub = subscribeFileChanges(server.url, "definitely-not-a-real-workspace");
    try {
      await sub.ready;
      // Touch a file in the OTHER workspace — should NOT leak to this sub.
      await writeFile(join(repoPath, "isolation-test.txt"), "x\n");
      await expect(sub.waitForFileChange(undefined, 600)).rejects.toThrow(/Timed out/);
    } finally {
      sub.close();
    }
  });

  it("scopes events to the subscribed workspace and ignores changes in other workspaces", async () => {
    // The point of the per-workspace subscription model: a client viewing
    // workspace A must not be woken up by file activity in workspace B,
    // and a watcher for B must not start at all just because A is being
    // viewed (see issue #384 — watching every worktree doesn't scale).
    const subA = subscribeFileChanges(server.url, workspaceId);
    try {
      await subA.ready;

      // Change a file in workspace B — subA must NOT receive it.
      await writeFile(join(otherRepoPath, "B-only.txt"), "B\n");
      await expect(subA.waitForFileChange(undefined, 600)).rejects.toThrow(/Timed out/);

      // Change a file in workspace A — subA must receive it.
      const wait = subA.waitForFileChange((p) => p === "");
      await writeFile(join(repoPath, "A-only.txt"), "A\n");
      const event = await wait;
      expect(event.path).toBe("");
    } finally {
      subA.close();
    }
  });

  it("delivers a file-change event to every subscriber of the same workspace", async () => {
    // Two browser tabs / dockview panels viewing the same workspace should
    // share one underlying `fs.watch` handle but each receive every event.
    // If a future change accidentally replaced (instead of accumulated) the
    // listener set on second subscribe, only one sub would receive events.
    const subA = subscribeFileChanges(server.url, workspaceId);
    const subB = subscribeFileChanges(server.url, workspaceId);
    try {
      await Promise.all([subA.ready, subB.ready]);

      const waitA = subA.waitForFileChange((p) => p === "src");
      const waitB = subB.waitForFileChange((p) => p === "src");
      await writeFile(join(repoPath, "src", "fanout.ts"), "// fanout\n");

      const [eventA, eventB] = await Promise.all([waitA, waitB]);
      expect(eventA.path).toBe("src");
      expect(eventB.path).toBe("src");
    } finally {
      subA.close();
      subB.close();
    }
  });

  it("keeps the watcher alive for remaining subscribers when one disconnects", async () => {
    // Refcount sanity: closing subA must not stop the watcher while subB
    // is still listening. Without proper refcounting, the second tab
    // would silently stop receiving events as soon as the first tab is
    // closed.
    const subA = subscribeFileChanges(server.url, workspaceId);
    const subB = subscribeFileChanges(server.url, workspaceId);
    try {
      await Promise.all([subA.ready, subB.ready]);

      subA.close();
      // Give the server a beat to process the unsubscribe — the watcher
      // must survive this teardown because subB is still attached.
      await new Promise((r) => setTimeout(r, 200));

      const waitB = subB.waitForFileChange((p) => p === "src");
      await writeFile(join(repoPath, "src", "survives.ts"), "// survives\n");
      const event = await waitB;
      expect(event.path).toBe("src");
    } finally {
      subB.close();
    }
  });

  it("ignores changes inside the .git directory", async () => {
    // `.git/` is the noisiest source of churn on a real worktree (every
    // `git` command rewrites refs, HEAD, index, etc.). The FileBrowser
    // never displays it, so it must not produce events.
    const sub = subscribeFileChanges(server.url, workspaceId);
    try {
      await sub.ready;
      await writeFile(join(repoPath, ".git", "PROBE"), "probe\n");
      await expect(
        sub.waitForFileChange((p) => p === "" || p.startsWith(".git"), 600),
      ).rejects.toThrow(/Timed out/);
    } finally {
      sub.close();
    }
  });

  it("emits a file-change event when a file is deleted", async () => {
    const target = join(repoPath, "src", "to-delete.ts");
    await writeFile(target, "// delete me\n");
    // Drain the create event before subscribing so the assertion below is
    // satisfied by the delete event, not the earlier write.
    await new Promise((r) => setTimeout(r, 400));

    const sub = subscribeFileChanges(server.url, workspaceId);
    try {
      await sub.ready;
      const wait = sub.waitForFileChange((p) => p === "src");
      await rm(target);
      const event = await wait;
      expect(event.path).toBe("src");
    } finally {
      sub.close();
    }
  });

  it("coalesces a burst of writes in the same directory into a small number of events", async () => {
    const burstDir = join(repoPath, "burst");
    await mkdir(burstDir, { recursive: true });
    // Allow the watcher to register the directory creation.
    await new Promise((r) => setTimeout(r, 400));

    const sub = subscribeFileChanges(server.url, workspaceId);
    try {
      await sub.ready;
      const before = sub.fileChanges.length;

      // 20 rapid writes inside `burst/` should fire far fewer events
      // thanks to the 250ms server-side debounce.
      const writes: Promise<unknown>[] = [];
      for (let i = 0; i < 20; i++) {
        writes.push(writeFile(join(burstDir, `f-${i}.ts`), `// ${i}\n`));
      }
      await Promise.all(writes);

      // Wait long enough that any in-flight debounce window has fired.
      await new Promise((r) => setTimeout(r, 1_000));

      const burstEvents = sub.fileChanges.slice(before).filter((e) => e.path === "burst");
      // At least one — the coalesced event for the burst — but well under
      // the 20 events one-per-write would produce. Pick a forgiving cap so
      // slow CI doesn't fail when the OS splits the burst across debounce
      // windows.
      expect(burstEvents.length).toBeGreaterThanOrEqual(1);
      expect(burstEvents.length).toBeLessThan(10);
    } finally {
      sub.close();
    }
  });
});
