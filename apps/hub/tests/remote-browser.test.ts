// Integration test for remote CDP (plan step 7.3): a real `band-worker` dials a real hub (the production bundle,
// auth on), a worktree is created on that worker, and a CDP client connects to the hub's `/cdp` WebSocket for it.
// The worker starts a real Chromium and the hub bridges CDP over a link channel. The page is served on the
// test machine's loopback, which is the worker's localhost because the worker runs here.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromium } from "@band-app/host-local/browser/chromium";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "remote-browser-shared-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const chromium = findChromium();

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hi\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

let server: ServerHandle;
let worker: ChildProcess | undefined;
let workerRoot: string;
let workerState: string;
let hostId: string;
let site: Server;
let origin: string;
let hubLog: string;
const worktreeId = "proj-cdp-feat";

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

/** A CDP client on the hub's `/cdp` endpoint, the way the pane connects. */
async function connectCdp(query: string) {
  const ws = new WebSocket(`${server.url.replace("http", "ws")}/cdp?${query}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("close", (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
  });
  let nextId = 0;
  // A closed socket fails the waiting calls at once, with the close reason, instead of timing the test out.
  const closed = new Promise<never>((_, reject) =>
    ws.once("close", (code, reason) => reject(new Error(`CDP socket closed ${code} ${reason}`))),
  );
  closed.catch(() => undefined);
  return {
    ws,
    send(method: string, params: unknown = {}, sessionId?: string) {
      const id = ++nextId;
      const reply = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return Promise.race([reply, closed]).then((message) => {
        if (message.error) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
        return message.result as Record<string, unknown>;
      });
    },
  };
}

/** Prints what the hub logged and the browser's own log, so a failed launch in CI names its cause. */
function printLaunchDiagnostics(): void {
  const lines: string[] = [];
  try {
    const log = readFileSync(hubLog, "utf8");
    lines.push(...log.split("\n").filter((l) => l.includes("remote CDP failed")));
  } catch {
    // no hub log
  }
  try {
    lines.push(
      `chromium.log: ${readFileSync(join(workerState, "browser", worktreeId, "chromium.log"), "utf8").slice(-2000)}`,
    );
  } catch {
    // browser never started
  }
  if (lines.length > 0) console.error(`remote browser launch diagnostics:\n${lines.join("\n")}`);
}

async function title(query: string, url: string): Promise<string> {
  try {
    return await readTitle(query, url);
  } catch (err) {
    printLaunchDiagnostics();
    throw err;
  }
}

async function readTitle(query: string, url: string): Promise<string> {
  const cdp = await connectCdp(query);
  try {
    const { targetId } = (await cdp.send("Target.createTarget", { url })) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    return await waitFor(
      async () => {
        const res = (await cdp.send(
          "Runtime.evaluate",
          { expression: "document.readyState === 'complete' ? document.title : ''" },
          sessionId,
        )) as { result: { value: string } };
        return res.result.value || undefined;
      },
      { label: "page title", timeoutMs: 15_000 },
    );
  } finally {
    cdp.ws.close();
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!chromium)("remote CDP for a worktree on a worker", () => {
  beforeAll(async () => {
    site = createServer((req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        ...(req.url === "/cookie" && {
          "set-cookie": `band=kept; Expires=${new Date(Date.now() + 3_600_000).toUTCString()}; Path=/`,
        }),
      });
      res.end(
        req.url === "/echo"
          ? `<title>cookie:${req.headers.cookie ?? "none"}</title>`
          : "<title>dev server on the worker</title>",
      );
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    const hubHome = createTmpHome("band-cdp-hub-");
    scratch.push(hubHome);
    workerRoot = tmp("band-cdp-root-");
    workerState = tmp("band-cdp-state-");
    const workerHome = tmp("band-cdp-whome-");
    const hubRepo = join(tmp("band-cdp-hubrepo-"), "proj");
    makeRepo(hubRepo);
    makeRepo(join(workerRoot, "proj"));
    seedSettings(hubHome, { tokenSecret: TOKEN });
    seedState(hubHome, {
      repos: [
        {
          name: "proj",
          path: hubRepo,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: hubRepo }],
        },
      ],
    });
    hubLog = join(hubHome, "hub.log");
    process.env.BAND_TEST_SERVER_LOG = hubLog;
    server = await startServer({
      tmpHome: hubHome,
      remoteHost: false,
      env: { BAND_SERVE_UI: "false" },
    });
    delete process.env.BAND_TEST_SERVER_LOG;
    const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
      hostName: "cdp-worker",
      labels: [],
    });
    hostId = issued.hostId;
    worker = spawn(
      process.execPath,
      [
        WORKER_BIN,
        "--hub",
        server.url,
        "--token",
        issued.token,
        "--root",
        workerRoot,
        "--state-dir",
        workerState,
      ],
      {
        env: {
          ...process.env,
          HOME: workerHome,
          BAND_HOME: join(workerHome, ".band"),
          BAND_CHROMIUM_BIN: chromium,
        },
        stdio: "ignore",
      },
    );
    await waitFor(
      async () =>
        (await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
          (h) => h.id === hostId && h.status === "online",
        ) ?? undefined,
      { label: "worker online", timeoutMs: 20_000 },
    );
    await m("worktrees.create", {
      repo: "proj",
      branch: "cdp-feat",
      hostId,
      hostRepoPath: join(workerRoot, "proj"),
    });
  }, 120_000);

  afterAll(async () => {
    worker?.kill("SIGKILL");
    await server?.close();
    site?.closeAllConnections();
    await new Promise<void>((r) => site?.close(() => r()));
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  // The first call starts Chromium. Its launch budget is 44 s, so the test waits longer than that and a
  // failed launch reports the launcher's error with the browser's log instead of a bare timeout.
  it("reads the title of a page on the worker's localhost through the hub (S1)", async () => {
    expect(await title(`worktreeId=${worktreeId}`, origin)).toBe("dev server on the worker");
  }, 90_000);

  it("keeps cookies across a reopen of the worktree's browser (S2)", async () => {
    expect(await title(`worktreeId=${worktreeId}`, `${origin}/cookie`)).toBe(
      "dev server on the worker",
    );
    const profile = join(workerState, "browser", worktreeId);
    expect(existsSync(join(profile, "DevToolsActivePort"))).toBe(true);
    // Ending the browser through a worktree removal is S3. Here a second connection must see the same browser.
    expect(await title(`worktreeId=${worktreeId}`, `${origin}/echo`)).toBe("cookie:band=kept");
  });

  it("refuses a /cdp upgrade without a valid token", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
      const outcome = await new Promise<string>((resolve) => {
        const ws = new WebSocket(
          `${server.url.replace("http", "ws")}/cdp?worktreeId=${worktreeId}`,
          {
            headers,
          },
        );
        ws.once("open", () => {
          ws.close();
          resolve("open");
        });
        ws.once("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
        ws.once("error", () => resolve("error"));
      });
      expect(outcome).not.toBe("open");
    }
  });

  it("closes the connection of a local worktree it cannot bridge", async () => {
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${server.url.replace("http", "ws")}/cdp?worktreeId=proj-main`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      ws.once("close", resolve);
      ws.once("error", reject);
    });
    expect(code).toBe(4000);
  });

  it("binds DevTools to loopback and ends Chromium when the worktree is removed (S3)", async () => {
    // Start from a known state so the test does not depend on the ones before it.
    await title(`worktreeId=${worktreeId}`, origin);
    const portFile = join(workerState, "browser", worktreeId, "DevToolsActivePort");
    const [port] = readFileSync(portFile, "utf8").split("\n");
    const listeners = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    expect(listeners).toContain("127.0.0.1:");
    expect(listeners).not.toMatch(/\*:|0\.0\.0\.0:|\[::\]:/);

    const pids = execFileSync("pgrep", ["-f", join(workerState, "browser", worktreeId)], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map(Number);
    expect(pids.length).toBeGreaterThan(0);
    await m("worktrees.remove", { repo: "proj", name: "cdp-feat" });
    await waitFor(async () => (pids.some(alive) ? undefined : true), {
      label: "chromium exit",
      timeoutMs: 15_000,
    });
  });
});
