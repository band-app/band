// Integration tests for the reaper (plan step 3.7). A real hub (the production bundle on a random
// port, temp BAND_HOME) runs runner hooks from settings.json and a reaper sweeps their machines.
//
// - "lost machines" and "orphans" use small fake hooks that write a marker file when `destroy`
//   runs, so the test sees what the hub destroyed and with which environment.
// - "maximum lifetime" and "destroy action" use the bundled `local` hook, which starts the real
//   `band-worker --ephemeral`, and the scripted ACP stub as the coding agent.
//
// The sweep interval and the grace periods are shortened with BAND_REAPER_* variables.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { waitFor } from "./helpers/wait-for";

const TOKEN = TEST_TOKEN;
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const RUNNERS_DIR = join(import.meta.dirname, "../../../runners");
const REAPER_ENV = {
  BAND_SERVE_UI: "false",
  BAND_REAPER_INTERVAL_MS: "300",
  BAND_REAPER_HELLO_GRACE_MS: "300",
  BAND_REAPER_OFFLINE_MS: "300",
};

interface Machine {
  id: string;
  requestId: string | null;
  runnerId: string;
  workerId: string;
  handle: string | null;
  state: "spawning" | "running" | "stopping" | "destroyed" | "lost";
  note: string | null;
  hostStatus: string | null;
}
interface Workspace {
  name: string;
  path: string;
  hostId?: string;
  lifecycle?: "sleeping" | "waking";
}
interface ProjectsList {
  projects: Array<{ name: string; worktrees: Workspace[] }>;
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
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

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const call = <T>(server: ServerHandle, kind: "q" | "m", procedure: string, input?: unknown) =>
  (kind === "q"
    ? trpcQuery(server.url, procedure, input, TOKEN)
    : trpcMutate(server.url, procedure, input, TOKEN)
  ).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

/** Runs a wait and, when it times out, adds what the hub says about its machines. */
async function explained<T>(server: ServerHandle, wait: Promise<T>): Promise<T> {
  try {
    return await wait;
  } catch (err) {
    const machines = await machinesOf(server).catch(() => []);
    const logs: string[] = [];
    for (const requestId of new Set(machines.map((m) => m.requestId).filter(Boolean))) {
      const { log } = await call<{ log: string | null }>(server, "q", "runners.log", { requestId });
      logs.push(`--- ${requestId}\n${log ?? ""}`);
    }
    throw new Error(
      `${err instanceof Error ? err.message : err}\n${JSON.stringify(machines, null, 2)}\n${logs.join("\n")}`,
    );
  }
}

const machinesOf = async (server: ServerHandle) =>
  (await call<{ machines: Machine[] }>(server, "q", "runners.machines")).machines;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("lost machines", () => {
  it("destroys a machine whose worker never said hello, after the grace period (S1)", async () => {
    const home = createTmpHome("band-reaper-lost-");
    scratch.push(home);
    const work = tmp("band-reaper-lost-hooks-");
    const marker = join(work, "destroyed.log");
    const spawnHook = script(
      join(work, "spawn.sh"),
      'echo "starting a machine that will never connect"\necho "BAND_MACHINE_HANDLE=ghost-$BAND_WORKER_ID"',
    );
    const destroyHook = script(
      join(work, "destroy.sh"),
      'echo "$BAND_WORKER_ID $BAND_MACHINE_HANDLE" >> "$MARKER"',
    );
    const runner = (timeoutSec: number) => ({
      id: "ghost",
      kind: "hook",
      spawn: spawnHook,
      destroy: destroyHook,
      labels: { pool: "ghost" },
      isolation: "process",
      maxConcurrent: 1,
      timeoutSec,
      env: { MARKER: marker },
    });
    seedSettings(home, { tokenSecret: TOKEN, runners: [runner(600)] });
    seedState(home, {
      projects: [
        {
          name: "ghostproj",
          path: "/tmp/fake/ghostproj",
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: "/tmp/fake/ghostproj" }],
        },
      ],
    });

    // Attempt in flight: the spawn hook is done, the hub waits (10 minutes) for the hello.
    let server = await startServer({ tmpHome: home, remoteHost: false, env: REAPER_ENV });
    let machine: Machine;
    try {
      await call(server, "m", "workspaces.create", {
        project: "ghostproj",
        branch: "needs-ghost",
        placement: { labels: { pool: "ghost" } },
      });
      machine = await waitFor(
        async () => (await machinesOf(server)).find((m) => m.state === "spawning" && m.handle),
        { label: "a spawning machine with a handle", timeoutMs: 30_000, intervalMs: 200 },
      );
      expect(machine.handle).toBe(`ghost-${machine.workerId}`);
      // The attempt owns the machine, so the reaper leaves it alone however old it is.
      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(marker)).toBe(false);
    } finally {
      await server.close({ keepTerminalDaemon: true });
    }

    // The hub restarts (nothing owns the machine now) with a one second hello timeout.
    seedSettings(home, { tokenSecret: TOKEN, runners: [runner(1)] });
    server = await startServer({ tmpHome: home, remoteHost: false, env: REAPER_ENV });
    try {
      const destroyed = await waitFor(
        async () => {
          const found = (await machinesOf(server)).find((m) => m.id === machine.id);
          return found?.state === "destroyed" ? found : undefined;
        },
        { label: "the silent machine destroyed", timeoutMs: 30_000, intervalMs: 200 },
      );
      expect(destroyed.note).toContain("did not say hello");
      expect(readFileSync(marker, "utf8")).toContain(
        `${machine.workerId} ghost-${machine.workerId}`,
      );
      // The host never connected, so its row is gone too.
      const hosts = await call<{ hosts: Array<{ id: string }> }>(server, "q", "hosts.list");
      expect(hosts.hosts.map((h) => h.id)).not.toContain(machine.workerId);
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe("orphans", () => {
  it("destroys a machine the status hook lists and the hub has no record of (S2)", async () => {
    const home = createTmpHome("band-reaper-orphan-");
    scratch.push(home);
    const work = tmp("band-reaper-orphan-hooks-");
    const live = join(work, "live.txt");
    const marker = join(work, "destroyed.log");
    writeFileSync(live, "stray-1\nstray-2\n");
    const statusHook = script(join(work, "status.sh"), 'cat "$LIVE"');
    // Like a real hook, destroy removes the machine, so it stops being listed.
    const destroyHook = script(
      join(work, "destroy.sh"),
      'w="$BAND_WORKER_ID"\n[ -n "$w" ] || w=none\necho "$BAND_RUNNER_ID handle=$BAND_MACHINE_HANDLE worker=$w" >> "$MARKER"\ngrep -v -x "$BAND_MACHINE_HANDLE" "$LIVE" > "$LIVE.new" || true\nmv "$LIVE.new" "$LIVE"',
    );
    seedSettings(home, {
      tokenSecret: TOKEN,
      runners: [
        {
          id: "strays",
          kind: "hook",
          spawn: join(work, "never-run.sh"),
          destroy: destroyHook,
          status: statusHook,
          labels: { pool: "strays" },
          isolation: "process",
          maxConcurrent: 1,
          timeoutSec: 30,
          env: { LIVE: live, MARKER: marker },
        },
      ],
    });
    const server = await startServer({ tmpHome: home, remoteHost: false, env: REAPER_ENV });
    try {
      await waitFor(
        async () =>
          (existsSync(marker) && readFileSync(marker, "utf8").trim().split("\n").length >= 2) ||
          undefined,
        {
          label: "both strays destroyed",
          timeoutMs: 30_000,
          intervalMs: 200,
        },
      );
      const lines = readFileSync(marker, "utf8").trim().split("\n").sort();
      expect(lines).toEqual([
        "strays handle=stray-1 worker=none",
        "strays handle=stray-2 worker=none",
      ]);
      expect(readFileSync(live, "utf8").trim()).toBe("");
      // Once gone they are not destroyed again.
      await new Promise((r) => setTimeout(r, 1200));
      expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      await server.close();
    }
  }, 120_000);

  it("the bundled local hooks list their workers and destroy by handle only what they started", async () => {
    const root = tmp("band-reaper-local-hooks-");
    // Started by a shell that exits, like a real worker, so init reaps it and `kill -0` ends at once.
    const sleeper = () =>
      Number(
        execFileSync("sh", ["-c", "sleep 300 >/dev/null 2>&1 </dev/null & echo $!"], {
          encoding: "utf8",
        }).trim(),
      );
    const worker = (name: string) => {
      const dir = join(root, name);
      mkdirSync(dir);
      const pid = sleeper();
      writeFileSync(join(dir, "pid"), String(pid));
      return { dir, pid };
    };
    const a = worker("w-a");
    const b = worker("w-b");
    const strangerPid = sleeper();
    const run = (hook: string, env: Record<string, string>) =>
      execFileSync(join(RUNNERS_DIR, "local", `${hook}.sh`), [], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", BAND_RUNNER_DIR: root, ...env },
      });
    try {
      expect(run("status", {}).trim().split("\n").sort()).toEqual(
        [String(a.pid), String(b.pid)].sort(),
      );

      // A handle that no directory holds is not a pid to kill.
      run("destroy", { BAND_MACHINE_HANDLE: String(strangerPid) });
      expect(isAlive(strangerPid)).toBe(true);

      run("destroy", { BAND_MACHINE_HANDLE: String(a.pid) });
      await waitFor(async () => !isAlive(a.pid), { label: "worker a stopped", timeoutMs: 5000 });
      expect(existsSync(a.dir)).toBe(false);
      expect(isAlive(b.pid)).toBe(true);

      run("destroy", { BAND_WORKER_ID: "w-b" });
      await waitFor(async () => !isAlive(b.pid), { label: "worker b stopped", timeoutMs: 5000 });
      expect(run("status", {}).trim()).toBe("");
    } finally {
      for (const pid of [a.pid, b.pid, strangerPid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
});

describe("maximum lifetime and the destroy action", () => {
  let server: ServerHandle;
  let hubHome: string;
  let origin: string;
  let checkout: string;
  const baseRunner = (extra: Record<string, unknown> = {}) => ({
    env: {} as Record<string, string>,
    id: "life",
    kind: "hook",
    spawn: "bundled:local",
    destroy: "bundled:local",
    status: "bundled:local",
    labels: { pool: "life" },
    isolation: "process",
    maxConcurrent: 3,
    timeoutSec: 90,
    ...extra,
  });
  let runnerEnv: Record<string, string>;
  const setRunner = (extra: Record<string, unknown> = {}) =>
    call(server, "m", "settings.update", {
      runners: [{ ...baseRunner(extra), env: runnerEnv }],
    });

  const q = <T>(procedure: string, input?: unknown) => call<T>(server, "q", procedure, input);
  const m = <T>(procedure: string, input: unknown) => call<T>(server, "m", procedure, input);
  const workspace = async (name: string) =>
    (await q<ProjectsList>("projects.list")).projects
      .find((p) => p.name === "lifeproj")
      ?.worktrees.find((w) => w.name === name);
  const runnerDir = (hostId: string) => join(hubHome, ".band", "runners", "life", hostId);
  const workerLog = (hostId: string) => {
    const file = join(runnerDir(hostId), "worker.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  const pidOf = (hostId: string) => Number(readFileSync(join(runnerDir(hostId), "pid"), "utf8"));
  const machineOf = async (hostId: string, state?: Machine["state"]) =>
    (await machinesOf(server)).find((x) => x.workerId === hostId && (!state || x.state === state));

  async function createWorkspace(branch: string): Promise<Workspace & { hostId: string }> {
    await m("workspaces.create", {
      project: "lifeproj",
      branch,
      placement: { labels: { pool: "life" } },
    });
    return (await waitFor(
      async () => {
        const wt = await workspace(branch);
        return wt?.hostId ? wt : undefined;
      },
      { label: `${branch} on a worker`, timeoutMs: 90_000, intervalMs: 250 },
    )) as Workspace & { hostId: string };
  }

  beforeAll(async () => {
    hubHome = createTmpHome("band-reaper-life-hub-");
    scratch.push(hubHome);
    const base = tmp("band-reaper-life-repos-");
    origin = join(base, "lifeproj-origin.git");
    mkdirSync(origin, { recursive: true });
    git(origin, "init", "-q", "--bare", "-b", "main");
    checkout = join(base, "lifeproj");
    git(base, "clone", "-q", origin, checkout);
    git(checkout, "checkout", "-q", "-b", "main");
    writeFileSync(join(checkout, "hello.txt"), "hello\n");
    git(checkout, "add", ".");
    git(checkout, "commit", "-q", "-m", "init");
    git(checkout, "push", "-q", "origin", "main");

    const stubState = tmp("band-reaper-stub-state-");
    const scenario = join(tmp("band-reaper-scenario-"), "scenario.json");
    writeFileSync(
      scenario,
      JSON.stringify({
        turns: [{ match: "^slow", steps: [{ say: "working" }, { sleep: 60000 }, { say: "done" }] }],
      }),
    );
    runnerEnv = {
      BAND_WORKER_BIN: WORKER_BIN,
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: stubState,
      BAND_TEST_ACP_SCENARIO: scenario,
      BAND_AGENT_SESSION_DIRS: stubState,
    };
    seedSettings(hubHome, {
      tokenSecret: TOKEN,
      codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
      defaultCodingAgent: "claude-code",
    });
    seedState(hubHome, {
      projects: [
        {
          name: "lifeproj",
          path: checkout,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: checkout }],
        },
      ],
    });
    server = await startServer({
      tmpHome: hubHome,
      remoteHost: false,
      env: { ...REAPER_ENV, BAND_REAPER_OFFLINE_MS: "2000" },
    });
    await setRunner();
  }, 120_000);

  afterAll(async () => {
    const base = join(hubHome ?? "", ".band", "runners", "life");
    if (existsSync(base)) {
      for (const id of readdirSync(base)) {
        try {
          process.kill(Number(readFileSync(join(base, id, "pid"), "utf8").trim()), "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await server?.close();
  });

  // A test that fails halfway must not leave a short lifetime on the runner for the next one.
  afterEach(async () => {
    await setRunner();
  });

  it("puts a machine past its maximum lifetime to sleep, then destroys it, and the work comes back (S3)", async () => {
    const wt = await createWorkspace("life-a");
    const hostId = wt.hostId;
    appendFileSync(join(wt.path, "hello.txt"), "edited on the worker\n");
    mkdirSync(join(wt.path, "notes"));
    writeFileSync(join(wt.path, "notes", "scratch.txt"), "scratch\n");

    // The machine is recorded with its handle, the worker's pid, and is not touched while it lives.
    const running = await waitFor(() => machineOf(hostId, "running"), {
      label: "the machine is running",
      timeoutMs: 30_000,
      intervalMs: 250,
    });
    const pid = pidOf(hostId);
    expect(running.handle).toBe(String(pid));
    await new Promise((r) => setTimeout(r, 1500));
    expect((await machineOf(hostId))?.state).toBe("running");
    expect(isAlive(pid)).toBe(true);

    // The runner's maximum lifetime is already over for this machine.
    await setRunner({ maxLifetimeSec: 2, lifetimeGraceSec: 120 });

    const destroyed = await explained(
      server,
      waitFor(() => machineOf(hostId, "destroyed"), {
        label: "the machine destroyed after it slept",
        timeoutMs: 90_000,
        intervalMs: 250,
      }),
    );
    expect(destroyed.note).toContain("maximum lifetime of 2s");
    // It handed its work over first: only the worker's persist pushes this ref.
    const ref = "refs/heads/band/wip/lifeproj-life-a";
    expect(git(origin, "show", `${ref}:hello.txt`)).toContain("edited on the worker");
    expect(git(origin, "show", `${ref}:notes/scratch.txt`)).toBe("scratch\n");
    expect(isAlive(pid)).toBe(false);
    // The destroy hook cleaned up after the worker. (A version manager on a developer machine can
    // leave a `.volta` directory in the worker's home, so the test looks for the worker's own files.)
    expect(existsSync(join(runnerDir(hostId), "pid"))).toBe(false);
    expect(existsSync(join(runnerDir(hostId), "work"))).toBe(false);
    expect((await workspace("life-a"))?.lifecycle).toBe("sleeping");

    // The workspace keeps its work: it wakes on a new machine with the edit present.
    await setRunner();
    const file = await q<{ content: string }>("workspace.getFile", {
      workspaceId: "lifeproj-life-a",
      path: "hello.txt",
    });
    expect(file.content).toBe("hello\nedited on the worker\n");
    expect((await workspace("life-a"))?.lifecycle).toBeUndefined();
    const states = (await machinesOf(server))
      .filter((x) => x.workerId === hostId)
      .map((x) => x.state)
      .sort();
    expect(states).toEqual(["destroyed", "running"]);
  }, 240_000);

  it("keeps a busy machine until its hard deadline, then destroys it and says so (S3)", async () => {
    const wt = await createWorkspace("life-b");
    const hostId = wt.hostId;
    const res = await fetch(`${server.url}/api/chats/life-busy/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
      body: JSON.stringify({ workspaceId: "lifeproj-life-b", text: "slow please" }),
    });
    expect(res.ok).toBe(true);

    const running = await waitFor(() => machineOf(hostId, "running"), {
      label: "the machine is running",
      timeoutMs: 30_000,
      intervalMs: 250,
    });
    // The lifetime ends now, and the deadline is 12 s later.
    const age = Math.ceil((Date.now() - (await spawnedAt(running.id))) / 1000);
    await setRunner({ maxLifetimeSec: age, lifetimeGraceSec: 12 });
    const deadline = (await spawnedAt(running.id)) + age * 1000 + 12_000;
    const pid = pidOf(hostId);

    const stopping = await waitFor(() => machineOf(hostId, "stopping"), {
      label: "the machine is stopping",
      timeoutMs: 30_000,
      intervalMs: 250,
    });
    await waitFor(
      async () =>
        (await machineOf(hostId))?.note?.includes("an agent is working") ? true : undefined,
      { label: "the agent keeps the worker", timeoutMs: 30_000, intervalMs: 250 },
    );
    expect(stopping.state).toBe("stopping");
    // Look at the machine on every sweep until 3 s have passed or the deadline is near, and
    // never after it: a loaded runner can spend most of the grace period on the waits above,
    // and a machine destroyed at its deadline is correct then.
    const watchUntil = Math.min(Date.now() + 3000, deadline - 1500);
    do {
      const row = await machineOf(hostId);
      if (Date.now() >= deadline - 500) break;
      expect(row?.state).toBe("stopping");
      expect(isAlive(pid)).toBe(true);
      await new Promise((r) => setTimeout(r, 250));
    } while (Date.now() < watchUntil);
    expect(workerLog(hostId)).not.toContain("the hub stored the workspaces");

    const destroyed = await waitFor(() => machineOf(hostId, "destroyed"), {
      label: "the machine destroyed at its hard deadline",
      timeoutMs: 60_000,
      intervalMs: 250,
    });
    expect(destroyed.note).toContain("hard deadline passed with workspaces NOT stored");
    expect(destroyed.note).toContain("lifeproj-life-b");
    await waitFor(async () => !isAlive(pid), { label: "worker stopped", timeoutMs: 10_000 });
    await setRunner();
  }, 240_000);

  const spawnedAt = async (machineId: string): Promise<number> => {
    const row = (
      await q<{ machines: Array<{ id: string; spawnedAt: number }> }>("runners.machines")
    ).machines.find((x) => x.id === machineId);
    if (!row) throw new Error(`no machine ${machineId}`);
    return row.spawnedAt;
  };

  it("lets only an admin destroy a machine, and refuses one with unstored workspaces unless forced (S4)", async () => {
    const wt = await createWorkspace("life-c");
    const hostId = wt.hostId;
    const machine = (await waitFor(() => machineOf(hostId, "running"), {
      label: "the machine is running",
      timeoutMs: 30_000,
      intervalMs: 250,
    })) as Machine;
    const pid = pidOf(hostId);

    const created = await trpcMutate(server.url, "tokens.createDevice", { label: "reader" }, TOKEN);
    const { token: plain } = await trpcData<{ token: string }>(created);
    const asPlain = await trpcMutate(
      server.url,
      "runners.destroyMachine",
      { id: machine.id, force: true },
      plain,
    );
    expect(asPlain.status).toBe(403);
    expect((await trpcQuery(server.url, "runners.machines", undefined, plain)).status).toBe(403);
    expect((await machineOf(hostId))?.state).toBe("running");
    expect(isAlive(pid)).toBe(true);

    // An admin is refused while the workspace on the machine is not stored, then forces it.
    const refused = await trpcMutate(
      server.url,
      "runners.destroyMachine",
      { id: machine.id },
      TOKEN,
    );
    expect(refused.status).toBe(409);
    expect(isAlive(pid)).toBe(true);
    const forced = await m<Machine>("runners.destroyMachine", { id: machine.id, force: true });
    expect(forced.state).toBe("destroyed");
    expect(forced.note).toContain("forced");
    await waitFor(async () => !isAlive(pid), { label: "worker stopped", timeoutMs: 10_000 });

    const missing = await trpcMutate(
      server.url,
      "runners.destroyMachine",
      { id: "rm-nope" },
      TOKEN,
    );
    expect(missing.status).toBe(404);
  }, 240_000);
});
