// Integration test for per-host trust levels (restricted, standard, admin). Two real `band-worker`s (A and B) dial a
// real hub. A shell on A calls the hub through the worker relay with curl, the way `band` does, while the test
// changes the trust level of A through `hosts.setTrust` with the hub's admin token.

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
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STUB_AGENT_PATH, TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

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

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

interface Worker {
  hostId: string;
  home: string;
  root: string;
  child: ChildProcess;
  httpLog: string;
}

let server: ServerHandle;
let a: Worker;
let b: Worker;
const wt = (repo: string, branch: string, w: Worker) => toWorktreeId(repo, branch, w.hostId);

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

interface Listed {
  worktreeId: string;
  hostId?: string;
  origin: { worktreeId: string; chatId?: string; terminalId?: string } | null;
}
const _worktreeOf = async (id: string): Promise<Listed | undefined> => {
  const { repos } = await q<{ repos: Array<{ worktrees: Listed[] }> }>("repos.list");
  return repos.flatMap((r) => r.worktrees).find((w) => w.worktreeId === id);
};

async function startWorker(
  label: string,
  hubRepos: string[],
  extraArgs: string[] = [],
): Promise<Worker> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: `worker-${label}`,
    labels: [`name=${label}`],
  });
  const home = tmp(`band-trust-${label}-home-`);
  const root = tmp(`band-trust-${label}-root-`);
  for (const repo of hubRepos) initRepo(join(root, repo));
  const httpLog = join(home, "http-log.jsonl");
  const child = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      ...extraArgs,
      "--root",
      root,
      "--state-dir",
      tmp(`band-trust-${label}-state-`),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        BAND_HOME: join(home, ".band"),
        BAND_TERMINAL_DAEMON: "0",
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(home, "acp-state"),
        BAND_TEST_ACP_HTTP_LOG: httpLog,
        BAND_TEST_ACP_SCENARIO: join(home, "scenario.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: `worker ${label} online`, timeoutMs: 20_000 },
  );
  return { hostId: issued.hostId, home, root, child, httpLog };
}

/** Runs curl in a shell on A. The body lands in a file so the test can read what the relay answered. */
class Shell {
  private n = 0;
  constructor(
    private readonly socket: TerminalSocket,
    private readonly dir: string,
  ) {}
  async call(
    kind: "trpc" | "mcp",
    path: string,
    body: unknown,
    method: "POST" | "GET" = "POST",
  ): Promise<{ status: number; body: string }> {
    const id = `c${++this.n}`;
    const out = join(this.dir, `${id}.out`);
    const code = join(this.dir, `${id}.code`);
    const data = method === "POST" ? `-d '${JSON.stringify(body)}'` : "";
    const headers = kind === "mcp" ? "-H 'accept: application/json, text/event-stream'" : "";
    // The marker's `$((0+1))` is only expanded once the shell runs the line, so the typed echo cannot match it.
    this.socket.type(
      `curl -s -o ${out} -w '%{http_code}' -X ${method} "$BAND_SERVER_URL${path}" -H "Cookie: band_token=$BAND_TOKEN" -H 'content-type: application/json' ${headers} ${data} > ${code}; echo fin-${id}-$((0+1))\r`,
    );
    await this.socket.waitForOutput(`fin-${id}-1`);
    return {
      status: Number(readFileSync(code, "utf8")),
      body: existsSync(out) ? readFileSync(out, "utf8") : "",
    };
  }
}

let shell: Shell;
let socket: TerminalSocket;
let chatB: string;
let termB: string;

const setTrust = (hostId: string, trust: "restricted" | "standard" | "admin") =>
  m("hosts.setTrust", { hostId, trust });

const message = (res: { body: string }): string => {
  try {
    const parsed = JSON.parse(res.body) as { error?: { message?: string } };
    return parsed.error?.message ?? res.body;
  } catch {
    return res.body;
  }
};

const query = (procedure: string, input?: unknown) =>
  input === undefined
    ? `/trpc/${procedure}`
    : `/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;

beforeAll(async () => {
  const hubHome = createTmpHome("band-trust-hub-");
  scratch.push(hubHome);
  const dir = join(tmp("band-trust-hub-proj-"), "proj");
  initRepo(dir);
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    repos: [
      {
        name: "proj",
        path: dir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: dir }],
      },
    ],
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(hubHome, "acp-state"),
    },
  });
  b = await startWorker("b", ["proj"]);
  a = await startWorker("a", ["proj"]);
  for (const w of [a, b]) {
    await m("worktrees.create", {
      repo: "proj",
      branch: `seed-${w === a ? "a" : "b"}`,
      hostId: w.hostId,
      hostRepoPath: join(w.root, "proj"),
    });
  }
  chatB = (
    await m<{ chat: { id: string } }>("chats.create", { worktreeId: wt("proj", "seed-b", b) })
  ).chat.id;
  termB = (
    await m<{ terminalId: string }>("terminal.create", {
      worktreeId: wt("proj", "seed-b", b),
    })
  ).terminalId;
  const created = await m<{ terminalId: string }>("terminal.create", {
    worktreeId: wt("proj", "seed-a", a),
  });
  socket = await TerminalSocket.open(server, {
    worktreeId: wt("proj", "seed-a", a),
    terminalId: created.terminalId,
    token: TEST_TOKEN,
  });
  shell = new Shell(socket, a.home);
}, 240_000);

afterAll(async () => {
  await socket?.close();
  a?.child.kill("SIGKILL");
  b?.child.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

const hostTrust = async (id: string) =>
  (await q<{ hosts: Array<{ id: string; trust: string }> }>("hosts.list")).hosts.find(
    (h) => h.id === id,
  )?.trust;

describe("trust levels", () => {
  it("starts a registered static host at standard (S8)", async () => {
    expect(await hostTrust(a.hostId)).toBe("standard");
    expect(await hostTrust(b.hostId)).toBe("standard");
  });

  it("defaults an ephemeral host to restricted until an admin sets a level (S8)", async () => {
    const eph = await startWorker("eph", [], ["--ephemeral"]);
    try {
      expect(await hostTrust(eph.hostId)).toBe("restricted");
      await setTrust(eph.hostId, "standard");
      expect(await hostTrust(eph.hostId)).toBe("standard");
    } finally {
      eph.child.kill("SIGKILL");
    }
  });

  describe("hosts.setTrust (S2)", () => {
    it("stores the level for an admin token and shows it in hosts.list", async () => {
      await setTrust(a.hostId, "restricted");
      expect(await hostTrust(a.hostId)).toBe("restricted");
      await setTrust(a.hostId, "standard");
      expect(await hostTrust(a.hostId)).toBe("standard");
    });

    it("refuses a device token that is not an admin", async () => {
      const device = await m<{ token: string }>("tokens.createDevice", { label: "plain" });
      const res = await trpcMutate(
        server.url,
        "hosts.setTrust",
        { hostId: a.hostId, trust: "admin" },
        device.token,
      );
      expect(res.status).toBe(403);
      expect(await hostTrust(a.hostId)).toBe("standard");
    });

    it("refuses a relay call from a worker, even one on an admin host", async () => {
      for (const level of ["standard", "admin"] as const) {
        await setTrust(a.hostId, level);
        const res = await shell.call("trpc", "/trpc/hosts.setTrust", {
          hostId: a.hostId,
          trust: "admin",
        });
        expect(res.status).toBe(403);
        const other = await shell.call("trpc", "/trpc/hosts.setTrust", {
          hostId: b.hostId,
          trust: "admin",
        });
        expect(other.status).toBe(403);
      }
      await setTrust(a.hostId, "standard");
      expect(await hostTrust(b.hostId)).toBe("standard");
    });
  });

  describe("standard host (S4)", () => {
    it("refuses a chat list, a terminal read and a send on another host", async () => {
      const list = await shell.call(
        "trpc",
        query("chats.list", { worktreeId: wt("proj", "seed-b", b) }),
        undefined,
        "GET",
      );
      expect(list.status).toBe(403);
      expect(message(list)).toContain("is not on this worker");
      const out = await shell.call(
        "trpc",
        query("terminal.output", { terminalId: termB }),
        undefined,
        "GET",
      );
      expect(out.status).toBe(403);
      const send = await shell.call("trpc", "/trpc/chats.send", {
        worktreeId: wt("proj", "seed-b", b),
        chatId: chatB,
        message: "hi",
      });
      expect(send.status).toBe(403);
    });

    it("refuses settings and a cronjob on another host's worktree", async () => {
      expect(
        (await shell.call("trpc", query("settings.get", undefined), undefined, "GET")).status,
      ).toBe(403);
      const job = await shell.call("trpc", "/trpc/cronjobs.create", {
        worktreeId: wt("proj", "seed-b", b),
        name: "r",
        prompt: "p",
        cronExpression: "0 0 1 1 *",
      });
      expect(job.status).toBe(403);
      expect(message(job)).toContain("is not on this worker");
    });
  });

  describe("restricted host (S5)", () => {
    beforeAll(() => setTrust(a.hostId, "restricted"));
    afterAll(() => setTrust(a.hostId, "standard"));

    it("keeps working on its own worktrees", async () => {
      const own = await shell.call(
        "trpc",
        query("chats.list", { worktreeId: wt("proj", "seed-a", a) }),
        undefined,
        "GET",
      );
      expect(own.status).toBe(200);
    });

    it("refuses worktrees.create, cronjobs.create and repos.add naming the level", async () => {
      const create = await shell.call("trpc", "/trpc/worktrees.create", {
        repo: "proj",
        branch: "nope",
      });
      expect(create.status).toBe(403);
      expect(message(create)).toContain("restricted");
      const job = await shell.call("trpc", "/trpc/cronjobs.create", {
        worktreeId: wt("proj", "seed-a", a),
        name: "j",
        prompt: "p",
        cronExpression: "0 0 1 1 *",
      });
      expect(job.status).toBe(403);
      expect(message(job)).toContain("restricted");
      const add = await shell.call("trpc", "/trpc/repos.add", { path: "/tmp/x" });
      expect(add.status).toBe(403);
      expect(message(add)).toContain("restricted");
    });

    it("refuses anything naming another host", async () => {
      const list = await shell.call(
        "trpc",
        query("chats.list", { worktreeId: wt("proj", "seed-b", b) }),
        undefined,
        "GET",
      );
      expect(list.status).toBe(403);
      expect(message(list)).toContain("restricted");
    });

    it("offers hosts.forAgents but not hosts.list", async () => {
      expect(
        (await shell.call("trpc", query("hosts.forAgents", undefined), undefined, "GET")).status,
      ).toBe(200);
      expect(
        (await shell.call("trpc", query("hosts.list", undefined), undefined, "GET")).status,
      ).toBe(403);
    });
  });

  describe("admin host (S3, S6, S7)", () => {
    beforeAll(() => setTrust(a.hostId, "admin"));
    afterAll(() => setTrust(a.hostId, "standard"));

    it("lists and sends to chats and reads terminals on another host", async () => {
      const list = await shell.call(
        "trpc",
        query("chats.list", { worktreeId: wt("proj", "seed-b", b) }),
        undefined,
        "GET",
      );
      expect(list.status).toBe(200);
      expect(list.body).toContain(chatB);
      const out = await shell.call(
        "trpc",
        query("terminal.output", { terminalId: termB }),
        undefined,
        "GET",
      );
      expect(out.status).toBe(200);
      const send = await shell.call("trpc", "/trpc/terminal.send", {
        terminalId: termB,
        data: "echo from-a\r",
      });
      expect(send.status).toBe(200);
      await waitFor(
        async () => {
          const res = await shell.call(
            "trpc",
            query("terminal.output", { terminalId: termB }),
            undefined,
            "GET",
          );
          return res.body.includes("from-a") ? true : undefined;
        },
        { label: "A's input reached B's terminal", timeoutMs: 15_000 },
      );
      const sendChat = await shell.call("trpc", "/trpc/chats.send", {
        worktreeId: wt("proj", "seed-b", b),
        chatId: chatB,
        message: "hello from a",
      });
      expect(sendChat.status).toBe(200);
    });

    it("creates a worktree and a cronjob on another host", async () => {
      const create = await shell.call("trpc", "/trpc/worktrees.create", {
        repo: "proj",
        branch: "made-by-a",
        hostId: b.hostId,
      });
      expect(create.status, create.body).toBe(200);
      const made = await q<{
        repos: Array<{ worktrees: Array<{ worktreeId: string; hostId?: string }> }>;
      }>("repos.list");
      const worktree = made.repos
        .flatMap((r) => r.worktrees)
        .find((w) => w.worktreeId === wt("proj", "made-by-a", b));
      expect(worktree?.hostId).toBe(b.hostId);
      const bJob = await shell.call("trpc", "/trpc/cronjobs.create", {
        worktreeId: wt("proj", "seed-b", b),
        name: "b job",
        prompt: "p",
        cronExpression: "0 0 1 1 *",
      });
      expect(bJob.status, bJob.body).toBe(200);
      const removed = await shell.call("trpc", "/trpc/worktrees.remove", {
        repo: "proj",
        name: "made-by-a",
        hostId: b.hostId,
      });
      expect(removed.status, removed.body).toBe(200);
    });

    it("sees the full host list and changes settings but never credentials or trust (S6)", async () => {
      const hostsRes = await shell.call("trpc", query("hosts.list", undefined), undefined, "GET");
      expect(hostsRes.status).toBe(200);
      expect(hostsRes.body).toContain("roots");
      expect(hostsRes.body).toContain('"trust"');
      expect(
        (await shell.call("trpc", query("settings.get", undefined), undefined, "GET")).status,
      ).toBe(200);
      const got = await shell.call("trpc", query("settings.get", undefined), undefined, "GET");
      expect(got.body).not.toContain(TEST_TOKEN);
      expect(
        (
          await shell.call("trpc", "/trpc/settings.update", {
            agents: { crossHostWorktrees: true },
          })
        ).status,
      ).toBe(200);
      for (const [proc, input] of [
        ["settings.update", { tokenSecret: "x".repeat(40) }],
        ["settings.update", { runners: [] }],
        [
          "settings.update",
          { codingAgents: [{ id: "x", type: "x", label: "x", command: "/tmp/x" }] },
        ],
        ["settings.update", { corsAllowedOrigins: ["https://evil.example"] }],
        ["settings.update", { somethingUnknown: 1 }],
        ["tokens.list", {}],
        ["tokens.createDevice", { label: "mine", admin: true }],
        ["vault.list", {}],
        ["hosts.setTrust", { hostId: b.hostId, trust: "admin" }],
        ["hosts.setAgentCommand", { hostId: a.hostId, agentId: "claude-code", command: "evil" }],
        ["workers.setAgentCommand", { hostId: b.hostId, agentId: "claude-code", command: "evil" }],
      ] as const) {
        const res = await shell.call("trpc", `/trpc/${proc}`, input);
        expect(res.status, proc).toBe(403);
      }
      expect(await hostTrust(b.hostId)).toBe("standard");
    });

    it("reads only the agent-settable settings, none of the hub's credentials or endpoints", async () => {
      await m("settings.update", { corsAllowedOrigins: ["https://secret-origin.example"] });
      const got = await shell.call("trpc", query("settings.get"), undefined, "GET");
      expect(got.status).toBe(200);
      for (const leaked of [
        "secret-origin.example",
        "corsAllowedOrigins",
        "codingAgents",
        "runners",
        "voice",
        "tokenSecret",
        "environmentBuilder",
        TEST_TOKEN,
      ]) {
        expect(got.body, leaked).not.toContain(leaked);
      }
      expect(got.body).toContain('"agents"');
    });

    it("never reaches the hub's own machine", async () => {
      const hubWorktree = wt("proj", "main", { hostId: "local" } as Worker);
      const refusals: Array<[string, string, unknown, "POST" | "GET"]> = [
        ["chats.list", query("chats.list", { worktreeId: hubWorktree }), undefined, "GET"],
        [
          "worktrees.create",
          "/trpc/worktrees.create",
          { repo: "proj", branch: "to-hub", hostId: "local" },
          "POST",
        ],
        [
          "worktrees.remove",
          "/trpc/worktrees.remove",
          { repo: "proj", name: "main", hostId: "local" },
          "POST",
        ],
        [
          "cronjobs.create",
          "/trpc/cronjobs.create",
          {
            worktreeId: hubWorktree,
            name: "hub job",
            prompt: "p",
            cronExpression: "0 0 1 1 *",
          },
          "POST",
        ],
      ];
      for (const [name, path, body, method] of refusals) {
        const res = await shell.call("trpc", path, body, method);
        expect(res.status, `${name}: ${res.body}`).toBe(403);
      }
    });

    it("refuses a folder root added from a worker, at every level", async () => {
      for (const level of ["standard", "admin"] as const) {
        await setTrust(a.hostId, level);
        const res = await shell.call("trpc", "/trpc/repos.addFromWorker", {
          hostId: b.hostId,
          path: join(b.root, "proj"),
          addRoot: true,
        });
        expect(res.status, level).toBe(403);
        expect(message(res)).toContain("person");
      }
      await setTrust(a.hostId, "admin");
    });

    it("takes effect when lowered, on the next call", async () => {
      await setTrust(a.hostId, "standard");
      const list = await shell.call(
        "trpc",
        query("chats.list", { worktreeId: wt("proj", "seed-b", b) }),
        undefined,
        "GET",
      );
      expect(list.status).toBe(403);
      await setTrust(a.hostId, "admin");
    });

    it("records cross-host calls in the audit log (S7)", async () => {
      const { entries } = await q<{
        entries: Array<{
          at: number;
          callerHostId: string;
          procedure: string;
          targetHostId: string | null;
          target: string | null;
        }>;
      }>("hosts.audit", { limit: 100 });
      const mine = entries.filter((e) => e.callerHostId === a.hostId);
      expect(mine.some((e) => e.procedure === "chats.list" && e.targetHostId === b.hostId)).toBe(
        true,
      );
      expect(
        mine.some((e) => e.procedure === "worktrees.create" && e.targetHostId === b.hostId),
      ).toBe(true);
      expect(mine.some((e) => e.procedure === "terminal.output" && e.target === termB)).toBe(true);
      expect(mine.every((e) => e.at > 0)).toBe(true);
      // An agent cannot read the log.
      const own = await shell.call("trpc", query("hosts.audit", {}), undefined, "GET");
      expect(own.status).toBe(403);
    });
  });
});
