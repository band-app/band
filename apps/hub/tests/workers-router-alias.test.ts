// `workers.*` and `hosts.*` are one router under two names. A real hub with one real `band-worker`
// answers both the same way, refuses a non-admin device token on the admin procedures under both
// names, and applies the same relay rules to both. A shell on the worker calls the hub through the
// worker relay with curl, the way `band` does.

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

const TOKEN = "workers-alias-secret";

import { WORKER_BIN } from "./helpers/worker-bin";

const NAMES = ["workers", "hosts"] as const;

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function initRepo(dir: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

let server: ServerHandle;
let worker: ChildProcess;
let workerHome: string;
let workerId: string;
let socket: TerminalSocket;
let deviceToken: string;

const query = async <T>(procedure: string, input?: unknown): Promise<T> => {
  const res = await trpcQuery(server.url, procedure, input, TOKEN);
  if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
  return trpcData<T>(res);
};
const mutate = async <T>(procedure: string, input: unknown): Promise<T> => {
  const res = await trpcMutate(server.url, procedure, input, TOKEN);
  if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
  return trpcData<T>(res);
};

/** Runs curl in a shell on the worker and reads back the status and body the relay answered. */
let calls = 0;
async function relay(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string; message: string }> {
  const id = `c${++calls}`;
  const out = join(workerHome, `${id}.out`);
  const code = join(workerHome, `${id}.code`);
  const method = body === undefined ? "GET" : "POST";
  const data = body === undefined ? "" : `-d '${JSON.stringify(body)}'`;
  // The marker's `$((0+1))` is only expanded once the shell runs the line, so the typed echo cannot match it.
  socket.type(
    `curl -s -o ${out} -w '%{http_code}' -X ${method} "$BAND_SERVER_URL${path}" -H "Cookie: band_token=$BAND_TOKEN" -H 'content-type: application/json' ${data} > ${code}; echo fin-${id}-$((0+1))\r`,
  );
  await socket.waitForOutput(`fin-${id}-1`);
  const text = existsSync(out) ? readFileSync(out, "utf8") : "";
  let message = text;
  try {
    message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
  } catch {
    // Not JSON: keep the raw text.
  }
  return { status: Number(readFileSync(code, "utf8")), body: text, message };
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-workers-alias-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-workers-alias-proj-"), "proj");
  initRepo(hubRepo);
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
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false" },
  });

  const issued = await mutate<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "alias-worker",
    labels: ["name=alias"],
  });
  workerId = issued.hostId;
  workerHome = tmp("band-workers-alias-whome-");
  const root = tmp("band-workers-alias-root-");
  initRepo(join(root, "proj"));
  worker = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      root,
      "--state-dir",
      tmp("band-workers-alias-state-"),
    ],
    {
      env: {
        ...process.env,
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
        BAND_TERMINAL_DAEMON: "0",
      },
      stdio: "ignore",
    },
  );
  await waitFor(
    async () =>
      (await query<{ hosts: Array<{ id: string; status: string }> }>("workers.list")).hosts.find(
        (h) => h.id === workerId,
      )?.status === "online"
        ? true
        : undefined,
    { label: "worker online", timeoutMs: 20_000 },
  );
  await mutate("worktrees.create", {
    repo: "proj",
    branch: "alias",
    hostId: workerId,
    hostRepoPath: join(root, "proj"),
  });
  const worktreeId = toWorktreeId("proj", "alias", workerId);
  const term = await mutate<{ terminalId: string }>("terminal.create", { worktreeId });
  socket = await TerminalSocket.open(server, {
    worktreeId,
    terminalId: term.terminalId,
    token: TOKEN,
  });
  deviceToken = (await mutate<{ token: string }>("tokens.createDevice", { label: "plain" })).token;
}, 180_000);

afterAll(async () => {
  await socket?.close();
  worker?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("workers.* and hosts.* answer the same", () => {
  it("returns the same list, agent view and audit log under both names", async () => {
    // The list carries live fields, so poll until two reads agree.
    await expect
      .poll(async () => {
        const [workers, hosts] = await Promise.all([query("workers.list"), query("hosts.list")]);
        return JSON.stringify(workers) === JSON.stringify(hosts);
      })
      .toBe(true);
    const workers = await query<{ hosts: Array<{ id: string }> }>("workers.list");
    expect(workers.hosts.map((h) => h.id)).toContain(workerId);

    const forAgents = await query<{ hosts: Array<Record<string, unknown>> }>("workers.forAgents");
    expect(forAgents).toEqual(await query("hosts.forAgents"));
    // The agent view keeps exactly these fields, so one added to the list later stays hidden.
    for (const row of forAgents.hosts) {
      expect(Object.keys(row).sort()).toEqual(
        ["agents", "arch", "capabilities", "id", "labels", "mode", "name", "os", "status"].sort(),
      );
    }
  });

  it("returns the same non-empty audit log under both names", async () => {
    // An admin worker's settings write goes in the log.
    await mutate("workers.setTrust", { hostId: workerId, trust: "admin" });
    try {
      const write = await relay("/trpc/settings.update", { translucentSidebar: false });
      expect(write.status).toBe(200);
    } finally {
      await mutate("workers.setTrust", { hostId: workerId, trust: "standard" });
    }
    const viaWorkers = await query<{ entries: Array<{ procedure: string }> }>("workers.audit");
    expect(viaWorkers.entries.some((e) => e.procedure === "settings.update")).toBe(true);
    expect(viaWorkers).toEqual(await query("hosts.audit"));
  });

  it("applies a trust level set through one name to the list read through the other", async () => {
    await mutate("workers.setTrust", { hostId: workerId, trust: "restricted" });
    const viaHosts = await query<{ hosts: Array<{ id: string; trust: string }> }>("hosts.list");
    expect(viaHosts.hosts.find((h) => h.id === workerId)?.trust).toBe("restricted");
    await mutate("hosts.setTrust", { hostId: workerId, trust: "standard" });
    const viaWorkers = await query<{ hosts: Array<{ id: string; trust: string }> }>("workers.list");
    expect(viaWorkers.hosts.find((h) => h.id === workerId)?.trust).toBe("standard");
  });
});

describe("admin procedures refuse a non-admin device token under both names", () => {
  for (const name of NAMES) {
    it(`${name}.setTrust, ${name}.audit, ${name}.remove and ${name}.browse answer 403`, async () => {
      const setTrust = await trpcMutate(
        server.url,
        `${name}.setTrust`,
        { hostId: workerId, trust: "admin" },
        deviceToken,
      );
      expect(setTrust.status).toBe(403);
      const audit = await trpcQuery(server.url, `${name}.audit`, undefined, deviceToken);
      expect(audit.status).toBe(403);
      const remove = await trpcMutate(
        server.url,
        `${name}.remove`,
        { hostId: workerId },
        deviceToken,
      );
      expect(remove.status).toBe(403);
      const browse = await trpcQuery(
        server.url,
        `${name}.browse`,
        { hostId: workerId },
        deviceToken,
      );
      expect(browse.status).toBe(403);
    });

    it(`${name}.list is readable by that token`, async () => {
      const res = await trpcQuery(server.url, `${name}.list`, undefined, deviceToken);
      expect(res.status).toBe(200);
    });
  }

  for (const name of NAMES) {
    it(`${name}.list answers 401 with no token`, async () => {
      const res = await fetch(`${server.url}/trpc/${name}.list`);
      expect(res.status).toBe(401);
    });
  }

  it("left the trust level alone", async () => {
    const { hosts } = await query<{ hosts: Array<{ id: string; trust: string }> }>("workers.list");
    expect(hosts.find((h) => h.id === workerId)?.trust).toBe("standard");
  });
});

describe("the worker relay treats both names the same", () => {
  it("answers list and forAgents with the same redacted reply", async () => {
    const workers = await relay("/trpc/workers.list");
    const hosts = await relay("/trpc/hosts.list");
    expect(workers.status).toBe(200);
    expect(hosts.status).toBe(200);
    expect(workers.body).toBe(hosts.body);
    const redacted = (
      JSON.parse(workers.body) as { result: { data: { hosts: Array<Record<string, unknown>> } } }
    ).result.data.hosts;
    expect(redacted.map((h) => h.id)).toContain(workerId);
    // The redacted view keeps no roots, home or tool versions.
    for (const h of redacted) {
      expect(h).not.toHaveProperty("roots");
      expect(h).not.toHaveProperty("home");
      expect(h).not.toHaveProperty("tools");
    }

    const agentsWorkers = await relay("/trpc/workers.forAgents");
    const agentsHosts = await relay("/trpc/hosts.forAgents");
    expect(agentsWorkers.status).toBe(200);
    expect(agentsWorkers.body).toBe(agentsHosts.body);
  });

  it("refuses setTrust, audit, remove and browse under both names, at standard trust", async () => {
    for (const name of NAMES) {
      const setTrust = await relay(`/trpc/${name}.setTrust`, { hostId: workerId, trust: "admin" });
      expect(setTrust.status).toBe(403);
      const audit = await relay(`/trpc/${name}.audit`);
      expect(audit.status).toBe(403);
      const remove = await relay(`/trpc/${name}.remove`, { hostId: workerId });
      expect(remove.status).toBe(403);
      const browse = await relay(
        `/trpc/${name}.browse?input=${encodeURIComponent(JSON.stringify({ hostId: workerId }))}`,
      );
      expect(browse.status).toBe(403);
    }
  });

  it("refuses setTrust and audit even on an admin worker", async () => {
    await mutate("workers.setTrust", { hostId: workerId, trust: "admin" });
    try {
      for (const name of NAMES) {
        const setTrust = await relay(`/trpc/${name}.setTrust`, {
          hostId: workerId,
          trust: "admin",
        });
        expect(setTrust.status).toBe(403);
        const audit = await relay(`/trpc/${name}.audit`);
        expect(audit.status).toBe(403);
      }
    } finally {
      await mutate("workers.setTrust", { hostId: workerId, trust: "standard" });
    }
  });

  it("keeps the list but not the full view on a restricted worker, under both names", async () => {
    await mutate("hosts.setTrust", { hostId: workerId, trust: "restricted" });
    try {
      for (const name of NAMES) {
        const list = await relay(`/trpc/${name}.list`);
        expect(list.status).toBe(403);
        expect(list.message).toContain("restricted");
        expect(list.message).toContain("worker's trust level");
        const forAgents = await relay(`/trpc/${name}.forAgents`);
        expect(forAgents.status).toBe(200);
        const rows = (
          JSON.parse(forAgents.body) as {
            result: { data: { hosts: Array<Record<string, unknown>> } };
          }
        ).result.data.hosts;
        expect(rows.map((h) => h.id)).toContain(workerId);
        for (const h of rows) {
          expect(h).not.toHaveProperty("roots");
          expect(h).not.toHaveProperty("home");
          expect(h).not.toHaveProperty("tools");
        }
      }
    } finally {
      await mutate("workers.setTrust", { hostId: workerId, trust: "standard" });
    }
  });
});
