// A real hub with real `band-worker` processes for the checkpoint tests. The hub is the
// production bundle on a random port with auth on, the workers dial it over the link, the coding
// agent is the scripted ACP stub, and everything (hub home, worker homes, roots, state dirs, the
// bare origins) is a temp directory. Nothing here touches the real HOME or ~/.band.

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
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatEvent } from "@band-app/shared/chat-events";
import { toWorktreeId } from "@band-app/shared/worktree-id";

import { maxId, openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./acp-chat";
import { seedSettings, seedState } from "./seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./server";
import { waitFor } from "./wait-for";

/** The lease the test hub grants workers: short, so waiting it out costs a couple of seconds. */
export const LEASE_MS = 1500;

export const WORKER_BIN = join(import.meta.dirname, "../../../worker/bin/band-worker.mjs");

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

export interface Worker {
  name: string;
  hostId: string;
  root: string;
  state: string;
  home: string;
  stubState: string;
  stubLog: string;
  token: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  /** The options it was started with, kept for a restart. */
  options: AddWorkerOptions;
  /** The last of what the process printed. */
  output(): string;
}

export interface CheckpointRow {
  id: string;
  worktreeId: string;
  trigger: string;
  dirty: boolean;
  sizeBytes: number;
  sessions: number;
  createdAt: number;
}

export interface World {
  server: ServerHandle;
  hubHome: string;
  /** A bare origin and the hub's clone of it, per repo name. */
  origins: Map<string, { origin: string; hub: string }>;
  q<T>(procedure: string, input?: unknown): Promise<T>;
  m<T>(procedure: string, input: unknown): Promise<T>;
  /** The status of a tRPC mutation that is expected to fail, with the error body. */
  mFail(procedure: string, input: unknown): Promise<{ status: number; body: string }>;
  tmp(prefix: string): string;
  addWorker(name: string, repos: string[], opts?: AddWorkerOptions): Promise<Worker>;
  /**
   * Starts the worker process again with the state it saved, as a restart of the same machine.
   * `opts` replaces options it was started with, such as a build without `--own-chats`.
   */
  restartWorker(w: Worker, opts?: Partial<AddWorkerOptions>): Promise<Worker>;
  /**
   * Stops the worker and waits until the hub sees it offline. By default it also waits out the
   * worker's lease (`LEASE_MS`), after which the hub lets its worktrees continue elsewhere. Pass
   * `{ waitForLease: false }` to look at the time in between.
   */
  killWorker(w: Worker, signal?: NodeJS.Signals, opts?: { waitForLease?: boolean }): Promise<void>;
  createWorktree(w: Worker, repo: string, branch: string): Promise<string>;
  worktreePath(w: Worker, repo: string, branch: string): string;
  turn(worktreeId: string, chatId: string, text: string): Promise<ChatEvent[]>;
  checkpoints(
    worktreeId: string,
  ): Promise<{ checkpoints: CheckpointRow[]; warning: string | null }>;
  stubRequests(
    w: Worker,
    method: string,
  ): Array<{ method: string; params: { sessionId?: string } }>;
  close(): Promise<void>;
}

export interface AddWorkerOptions {
  /** Leave the scripted ACP agent out of the worker's environment, so it resolves agents as a real machine does. */
  noStubAgent?: boolean;
  /** Start the worker with `--own-chats`, so it runs its worktrees' chats. */
  ownChats?: boolean;
  /** The hub URL the worker dials instead of the hub's own, such as a proxy a test can cut. */
  hubUrl?: string;
  /** Extra environment for the worker, such as a scenario for the scripted agent. */
  env?: Record<string, string>;
}

export interface WorldOptions {
  /** Extra settings for the hub, merged over the defaults (for example more coding agents). */
  settings?: Record<string, unknown>;
  /** Repos to create, each with a bare origin and the hub's clone. */
  repos: Array<{ name: string }>;
  /** Extra environment for the hub. */
  env?: Record<string, string>;
}

export async function startWorld(opts: WorldOptions): Promise<World> {
  const scratch: string[] = [];
  const tmp = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    scratch.push(dir);
    return dir;
  };
  // A `claude` the capability probe finds (`BAND_AGENT_BIN_DIRS`), so a worker with the scripted
  // agent reports Claude Code as installed and logged in (`ANTHROPIC_API_KEY`), as a real one would.
  const agentBin = tmp("band-ckpt-agent-bin-");
  writeFileSync(join(agentBin, "claude"), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  const workers: Worker[] = [];
  const lastEventId = new Map<string, number>();
  const hubHome = createTmpHome("band-ckpt-hub-");
  scratch.push(hubHome);
  const base = tmp("band-ckpt-repos-");
  const origins = new Map<string, { origin: string; hub: string }>();
  for (const r of opts.repos) {
    const origin = join(base, `${r.name}-origin.git`);
    mkdirSync(origin, { recursive: true });
    git(origin, "init", "-q", "--bare", "-b", "main");
    const hub = join(base, r.name);
    git(base, "clone", "-q", origin, hub);
    git(hub, "checkout", "-q", "-b", "main");
    writeFileSync(join(hub, "hello.txt"), "hello\n");
    git(hub, "add", ".");
    git(hub, "commit", "-q", "-m", "init");
    git(hub, "push", "-q", "origin", "main");
    origins.set(r.name, { origin, hub });
  }
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
    ...opts.settings,
  });
  seedState(hubHome, {
    repos: opts.repos.map((r) => ({
      name: r.name,
      path: origins.get(r.name)?.hub ?? "",
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: origins.get(r.name)?.hub ?? "" }],
    })),
  });
  const server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(hubHome, "acp-state"),
      BAND_CHECKPOINT_POLL_MS: "500",
      BAND_CHECKPOINT_QUIET_MS: "1500",
      BAND_WORKER_LEASE_MS: String(LEASE_MS),
      ...opts.env,
    },
  });

  const q = <T>(procedure: string, input?: unknown) =>
    trpcQuery(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
      if (res.status !== 200)
        throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
      return trpcData<T>(res);
    });
  const m = <T>(procedure: string, input: unknown) =>
    trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
      if (res.status !== 200)
        throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
      return trpcData<T>(res);
    });

  const spawnWorker = (
    w: Omit<Worker, "child" | "exited" | "options" | "output">,
    spawnOpts: AddWorkerOptions = {},
  ): Worker => {
    const child = spawn(
      process.execPath,
      [
        WORKER_BIN,
        "--hub",
        spawnOpts.hubUrl ?? server.url,
        "--token",
        w.token,
        "--root",
        w.root,
        "--state-dir",
        w.state,
        ...(spawnOpts.ownChats ? ["--own-chats"] : []),
      ],
      {
        env: {
          ...process.env,
          HOME: w.home,
          BAND_HOME: join(w.home, ".band"),
          // Vitest puts the stub in every child's environment, so a worker without it unsets it.
          ...(spawnOpts.noStubAgent
            ? { BAND_TEST_ACP_AGENT: "" }
            : {
                BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
                BAND_TEST_ACP_STATE: w.stubState,
                BAND_TEST_ACP_LOG: w.stubLog,
                BAND_AGENT_SESSION_DIRS: w.stubState,
                BAND_AGENT_BIN_DIRS: agentBin,
                ANTHROPIC_API_KEY: "test-key",
              }),
          ...spawnOpts.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-20_000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    return { ...w, child, exited, options: spawnOpts, output: () => output };
  };

  const hostStatus = async (hostId: string) =>
    (await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
      (h) => h.id === hostId,
    )?.status;

  const world: World = {
    server,
    hubHome,
    origins,
    q,
    m,
    tmp,
    async mFail(procedure, input) {
      const res = await trpcMutate(server.url, procedure, input, TEST_TOKEN);
      return { status: res.status, body: await res.text() };
    },
    async addWorker(name, repos, addOpts = {}) {
      const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
        hostName: name,
        labels: [],
      });
      const home = tmp(`band-ckpt-${name}-home-`);
      const root = tmp(`band-ckpt-${name}-root-`);
      for (const repo of repos) {
        const o = origins.get(repo);
        if (!o) throw new Error(`unknown repo ${repo}`);
        git(root, "clone", "-q", o.origin, join(root, repo));
      }
      const stubState = join(home, "acp-state");
      mkdirSync(stubState, { recursive: true });
      const w = spawnWorker(
        {
          name,
          hostId: issued.hostId,
          root,
          state: tmp(`band-ckpt-${name}-state-`),
          home,
          stubState,
          stubLog: join(home, "stub-log.jsonl"),
          token: issued.token,
        },
        addOpts,
      );
      workers.push(w);
      await waitFor(async () => ((await hostStatus(w.hostId)) === "online" ? true : undefined), {
        label: `${name} online`,
        timeoutMs: 30_000,
      }).catch((err: Error) => {
        throw new Error(`${err.message}\n${w.output()}`);
      });
      return w;
    },
    async restartWorker(w, opts = {}) {
      const next = spawnWorker({ ...w }, { ...w.options, ...opts });
      workers.push(next);
      await waitFor(async () => ((await hostStatus(w.hostId)) === "online" ? true : undefined), {
        label: `${w.name} back online`,
        timeoutMs: 30_000,
      });
      return next;
    },
    async killWorker(w, signal = "SIGKILL", killOpts = {}) {
      w.child.kill(signal);
      await w.exited;
      await waitFor(async () => ((await hostStatus(w.hostId)) !== "online" ? true : undefined), {
        label: `${w.name} offline`,
        timeoutMs: 30_000,
      });
      // The lease the worker held ends one lease time after the hub last heard from it.
      if (killOpts.waitForLease !== false) {
        await new Promise((r) => setTimeout(r, LEASE_MS + 700));
      }
    },
    async createWorktree(w, repo, branch) {
      await m("worktrees.create", {
        repo,
        branch,
        hostId: w.hostId,
        hostRepoPath: join(w.root, repo),
      });
      return toWorktreeId(repo, branch, w.hostId);
    },
    worktreePath: (w, repo, branch) => join(w.root, ".band-worktrees", repo, branch),
    async turn(worktreeId, chatId, text) {
      // Only a turn that ends after this message counts, not the ones the chat already replayed.
      const after = lastEventId.get(chatId) ?? 0;
      const stream = await openStream(server.url, chatId, {
        lastEventId: after,
        until: (e) => turnEnded(e) && (e.eventId > after || e.eventId < 0),
        timeoutMs: 60_000,
      });
      const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
        body: JSON.stringify({ worktreeId, text }),
      });
      if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
      const events = await stream.events;
      lastEventId.set(chatId, Math.max(after, maxId(events)));
      return events;
    },
    checkpoints: (worktreeId) => q("checkpoints.list", { worktreeId }),
    stubRequests(w, method) {
      if (!existsSync(w.stubLog)) return [];
      return readFileSync(w.stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method: string; params: { sessionId?: string } })
        .filter((r) => r.method === method);
    },
    async close() {
      for (const w of workers) {
        try {
          w.child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await server.close();
      for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    },
  };
  return world;
}
