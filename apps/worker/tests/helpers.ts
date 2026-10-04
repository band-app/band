import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LinkServer, MAX_MESSAGE_BYTES, type ServerSession } from "@band-app/link";
import { WebSocketServer } from "ws";
import { parseConfig } from "../src/config.ts";
import { Worker } from "../src/worker.ts";

// Nothing in these tests may touch the real ~/.band, and the agents are the
// scripted ACP stub, not the installed adapters.
export const BAND_HOME = realpathSync(mkdtempSync(join(tmpdir(), "band-worker-home-")));
process.env.BAND_HOME = BAND_HOME;
process.env.SHELL = "/bin/bash";
export const ACP_STUB = fileURLToPath(
  new URL("../../hub/tests/fixtures/acp-stub-agent.mjs", import.meta.url),
);
process.env.BAND_TEST_ACP_AGENT = ACP_STUB;

export const WORKER_BIN = fileURLToPath(new URL("../bin/band-worker.mjs", import.meta.url));
export const TOKEN = "test-token";

/** A directory under the temp dir, resolved so it matches what the worker reports. */
export function tmpDir(prefix = "band-worker-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

export interface BootstrapCall {
  token: string;
  /** The worker id the hub assigned, which is the one the worker asked for or a fresh one. */
  workerId: string;
  name?: string;
}

export interface TestHub {
  server: LinkServer;
  /** `http://127.0.0.1:<port>`, as a worker is given it. */
  url: string;
  /** Every `POST /api/workers/exchange` the hub accepted. */
  bootstraps: BootstrapCall[];
  /** Resolves with the next worker session that completes a handshake. */
  nextSession(): Promise<ServerSession>;
  close(): Promise<void>;
}

/**
 * A hub stand-in on a random port: `/api/workers/connect` runs the link
 * handshake and `POST /api/workers/exchange` trades a bootstrap token for a
 * session token. It accepts the given credentials, and the session token it
 * issues for every redial after that.
 */
export async function startHub(
  opts: { credentials?: string[]; bootstrapTokens?: string[] } = {},
): Promise<TestHub> {
  const credentials = opts.credentials ?? [TOKEN];
  const bootstrapTokens = opts.bootstrapTokens ?? [];
  const bootstraps: BootstrapCall[] = [];
  const server = new LinkServer({
    authenticate: (hello) => {
      const sessionToken = `sess-${hello.workerId}`;
      return credentials.includes(hello.token) || hello.token === sessionToken
        ? { ok: true, sessionToken }
        : { ok: false, reason: "bad token" };
    },
    heartbeatMs: 1000,
  });

  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Omit<BootstrapCall, "workerId"> & {
        workerId?: string;
      };
      if (req.method !== "POST" || req.url !== "/api/workers/exchange") {
        res.writeHead(404).end();
      } else if (!bootstrapTokens.includes(parsed.token)) {
        res.writeHead(401).end();
      } else {
        const workerId = parsed.workerId ?? `w-stub${bootstraps.length}`;
        bootstraps.push({
          token: parsed.token,
          workerId,
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionToken: `sess-${workerId}`, workerId }));
      }
    });
  });
  const wss = new WebSocketServer({
    server: http,
    path: "/api/workers/connect",
    maxPayload: MAX_MESSAGE_BYTES,
  });
  wss.on("connection", (ws) => server.handleConnection(ws));
  const port = await new Promise<number>((resolve) =>
    http.listen(0, "127.0.0.1", () => {
      const addr = http.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    }),
  );
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    bootstraps,
    nextSession: () =>
      new Promise((resolve) => {
        const on = (s: ServerSession) => {
          server.off("connected", on);
          resolve(s);
        };
        server.on("connected", on);
      }),
    close: async () => {
      await server.close();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

export interface TestWorker {
  worker: Worker;
  session: ServerSession;
  root: string;
  stateDir: string;
}

/** Starts an attached worker in this process and waits for the hub to see it. */
export async function startWorker(
  hub: TestHub,
  extra: { args?: string[]; root?: string; stateDir?: string; token?: string } = {},
): Promise<TestWorker> {
  const root = extra.root ?? tmpDir();
  const stateDir = extra.stateDir ?? tmpDir("band-worker-state-");
  const config = parseConfig(
    [
      "--hub",
      hub.url,
      "--token",
      extra.token ?? TOKEN,
      "--root",
      root,
      "--state-dir",
      stateDir,
      ...(extra.args ?? []),
    ],
    {},
  );
  const connected = hub.nextSession();
  const worker = await Worker.start(config, { link: { reconnect: { minMs: 20, maxMs: 100 } } });
  return { worker, session: await connected, root, stateDir };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

export function makeRepo(root: string, name = "repo"): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

type Encoded = { json: unknown } | { bytes: string } | { chan: number; as: "json" | "bytes" };

/** Calls a worker method and unwraps its result, reading a result channel to the end when there is one. */
export async function call<T = unknown>(
  session: ServerSession,
  method: string,
  params?: unknown,
): Promise<T> {
  const enc = (await session.request(method, params)) as Encoded;
  return decode(session, enc) as Promise<T>;
}

export async function decode(session: ServerSession, enc: Encoded): Promise<unknown> {
  if ("json" in enc) return enc.json;
  if ("bytes" in enc) return Buffer.from(enc.bytes, "base64");
  const ch = session.getChannel(enc.chan);
  if (!ch) throw new Error(`result channel ${enc.chan} is not open`);
  const data = await ch.readAll();
  ch.end();
  return enc.as === "json" ? JSON.parse(data.toString()) : data;
}

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface WorkerProcess {
  child: ChildProcess;
  /** Everything the process wrote to stdout and stderr so far. */
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Runs the real `band-worker` binary with a throwaway BAND_HOME. */
export function spawnWorkerProcess(args: string[], env: NodeJS.ProcessEnv = {}): WorkerProcess {
  const child = spawn(process.execPath, [WORKER_BIN, ...args], {
    env: { ...process.env, BAND_HOME, LOG_LEVEL: "debug", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (d) => {
    output += d;
  });
  child.stderr?.on("data", (d) => {
    output += d;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, output: () => output, exited };
}
