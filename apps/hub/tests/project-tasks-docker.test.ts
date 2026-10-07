// Integration test for a two-member task on the bundled `docker` runner hook (plan step T.4). A real hub (the
// production bundle, temp BAND_HOME) runs `runners/docker` against a real docker daemon. A task with two repos starts
// one worker container. Both member worktrees exist under the task folder in it, and each member's install step ran
// in its own worktree. The worker then idles out, the container goes away, and a file read wakes the task: both
// worktrees are back in the new container.
//
// It needs what runner-docker.test.ts needs (a docker daemon, the worker image, loopback reachable from the container),
// and is skipped without BAND_DOCKER_TEST_IMAGE. The repos' origin is a `git daemon` on loopback, because the
// container clones the first repo itself and the worker clones the other through `repos.ensure`. The same
// BAND_DOCKER_TEST_PORT, _GIT_PORT, _HUB_URL, _GIT_URL and _NETWORK variables apply as there.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const IMAGE = process.env.BAND_DOCKER_TEST_IMAGE ?? "";
const NETWORK = process.env.BAND_DOCKER_TEST_NETWORK ?? "host";
const TOKEN = "docker-task-shared-secret";
const RUNNER = "docker-task";
// The container is idle this long before the hub stores the task and lets the worker exit.
const IDLE_MS = 15_000;

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function dockerHas(image: string): boolean {
  try {
    docker("image", "inspect", image);
    return true;
  } catch {
    return false;
  }
}

interface TaskView {
  id: string;
  name: string;
  hostId: string | null;
  folder: string | null;
  members: Array<{ repo: string; worktreeId: string | null; path: string | null }>;
}
interface Worktree {
  name: string;
  path: string;
  hostId?: string;
  lifecycle?: "sleeping" | "waking";
}

let server: ServerHandle;
let hubHome: string;
let gitDaemon: ReturnType<typeof spawn> | undefined;

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
const containerOf = (hostId: string) =>
  docker("ps", "--quiet", "--filter", `label=band.worker=${hostId}`).split("\n").filter(Boolean);
const inContainer = (container: string, script: string) =>
  docker("exec", container, "sh", "-c", script);
const worktreeOf = async (repo: string, name: string) =>
  (await q<{ repos: Array<{ name: string; worktrees: Worktree[] }> }>("repos.list")).repos
    .find((r) => r.name === repo)
    ?.worktrees.find((w) => w.name === name);

// Linux CI has docker, so a missing image or daemon there is a broken job, not a reason to skip.
const mustRun =
  process.env.CI === "true" &&
  process.platform === "linux" &&
  !process.env.BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB;
if (mustRun && !(IMAGE && dockerHas(IMAGE))) {
  throw new Error(
    "CI on Linux requires project-tasks-docker.test.ts to run: set BAND_DOCKER_TEST_IMAGE to a worker image " +
      `a docker daemon has (got "${IMAGE}"), or set BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB=1 in a job that does not build it`,
  );
}

describe.skipIf(!IMAGE)("a two-member task on the docker runner", () => {
  beforeAll(async () => {
    hubHome = createTmpHome("band-task-docker-hub-");
    const origin = tmp("band-task-docker-origin-");
    const port = Number(process.env.BAND_DOCKER_TEST_GIT_PORT) || (await freePort());
    const gitUrl = process.env.BAND_DOCKER_TEST_GIT_URL ?? `git://127.0.0.1:${port}`;
    const hubRepos = ["api", "client"].map((name) => {
      const bare = join(origin, name);
      const seed = join(tmp(`band-task-docker-seed-${name}-`), name);
      mkdirSync(seed, { recursive: true });
      git(seed, "init", "-q", "-b", "main");
      writeFileSync(join(seed, "hello.txt"), `${name}\n`);
      // The install step of each member leaves a marker only that member's worktree holds.
      mkdirSync(join(seed, ".band"));
      writeFileSync(
        join(seed, ".band", "environment.json"),
        JSON.stringify({ install: `echo ${name} > .${name}-installed` }),
      );
      git(seed, "add", ".");
      git(seed, "commit", "-q", "-m", "init");
      execFileSync("git", ["clone", "-q", "--bare", seed, bare], { env: gitEnv });
      git(seed, "remote", "add", "origin", `${gitUrl}/${name}`);
      return {
        name,
        path: seed,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: seed }],
      };
    });
    gitDaemon = spawn(
      "git",
      [
        "daemon",
        `--base-path=${origin}`,
        "--export-all",
        `--port=${port}`,
        "--listen=127.0.0.1",
        origin,
      ],
      { stdio: "ignore" },
    );
    await new Promise((r) => setTimeout(r, 500));

    seedSettings(hubHome, {
      tokenSecret: TOKEN,
      codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
      defaultCodingAgent: "claude-code",
    });
    seedState(hubHome, { repos: hubRepos });
    server = await startServer({
      tmpHome: hubHome,
      remoteHost: false,
      port: Number(process.env.BAND_DOCKER_TEST_PORT) || undefined,
      env: {
        BAND_SERVE_UI: "false",
        BAND_REAPER_INTERVAL_MS: "500",
        BAND_EPHEMERAL_IDLE_TIMEOUT_MS: String(IDLE_MS),
      },
    });
    await m("settings.update", {
      runners: [
        {
          id: RUNNER,
          spawn: "bundled:docker",
          destroy: "bundled:docker",
          status: "bundled:docker",
          labels: { pool: RUNNER },
          isolation: "container",
          maxConcurrent: 1,
          timeoutSec: 150,
          env: {
            BAND_DOCKER_IMAGE: IMAGE,
            BAND_DOCKER_NETWORK: NETWORK,
            ...(process.env.BAND_DOCKER_TEST_HUB_URL
              ? { BAND_HUB_URL: process.env.BAND_DOCKER_TEST_HUB_URL }
              : {}),
            ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
          },
        },
      ],
    });
    await m("projects.create", {
      name: "dp",
      repos: [{ repo: "api", role: "primary" }, { repo: "client" }],
      policy: { autonomy: "autonomous", labels: [`pool=${RUNNER}`] },
    });
  }, 180_000);

  afterAll(async () => {
    try {
      const left = docker("ps", "--all", "--quiet", "--filter", `label=band.runner=${RUNNER}`);
      for (const id of left.split("\n").filter(Boolean)) docker("rm", "--force", "--volumes", id);
    } catch {
      // Nothing to clean up.
    }
    gitDaemon?.kill();
    await server?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    if (hubHome) removeTmpHome(hubHome);
  });

  let task: TaskView;
  let hostId = "";

  it("starts one container with both member worktrees in the task folder and each install run (S2)", async () => {
    const created = await m<{ provisioning?: { requestId: string } }>("projectTasks.create", {
      project: "dp",
      branch: "feat/two",
      brief: "# two repos\n",
      repos: [{ repo: "api" }, { repo: "client" }],
      placement: { isolation: "container" },
      start: false,
    });
    const requestId = created.provisioning?.requestId;
    expect(requestId, "no attached host fits, so the docker runner is asked").toBeTruthy();

    try {
      await waitFor(
        async () => {
          const { requests } = await q<{
            requests: Array<{ id: string; status: string; error: string | null }>;
          }>("hostRequests.list");
          const mine = requests.find((r) => r.id === requestId);
          if (mine?.status === "failed") throw new Error(`request failed: ${mine.error}`);
          return mine ? undefined : true;
        },
        { label: "the task request completes", timeoutMs: 240_000, intervalMs: 500 },
      );
    } catch (err) {
      const log = await q<{ log: string | null }>("runners.log", {
        requestId: requestId as string,
      }).catch(() => null);
      throw new Error(`${err instanceof Error ? err.message : err}\nlog:\n${log?.log ?? "(none)"}`);
    }
    ({ task } = await q<{ task: TaskView }>("projectTasks.get", {
      task: "feat-two",
      project: "dp",
    }));
    hostId = task.hostId as string;
    expect(hostId).toBeTruthy();
    expect(task.members.map((x) => x.repo)).toEqual(["api", "client"]);

    const containers = containerOf(hostId);
    expect(containers, "one container serves the task").toHaveLength(1);
    const [container] = containers as [string];
    const folder = task.folder as string;
    expect(inContainer(container, `cat ${folder}/BRIEF.md`)).toContain("two repos");
    for (const repo of ["api", "client"]) {
      expect(inContainer(container, `git -C ${folder}/${repo} rev-parse --abbrev-ref HEAD`)).toBe(
        "feat/two",
      );
    }
    // The install of each member ran in its own worktree, and only there.
    await waitFor(
      () => {
        try {
          return (
            inContainer(container, `cat ${folder}/api/.api-installed`) === "api" &&
            inContainer(container, `cat ${folder}/client/.client-installed`) === "client"
          );
        } catch {
          return undefined;
        }
      },
      { label: "each member's install ran", timeoutMs: 60_000, intervalMs: 500 },
    );
    expect(() => inContainer(container, `test -e ${folder}/api/.client-installed`)).toThrow();
  }, 300_000);

  it("restores both worktrees after sleep and wake (S4)", async () => {
    const folder = task.folder as string;
    const [first] = containerOf(hostId);
    // An uncommitted edit in each member must survive the hand-off.
    for (const repo of ["api", "client"]) {
      inContainer(first as string, `echo edit-${repo} >> ${folder}/${repo}/hello.txt`);
    }
    // The setup of each member left its terminal open, and the hub keeps a worker with a terminal awake.
    for (const worktreeId of ["api-feat-two", "client-feat-two"]) {
      const { terminals } = await q<{ terminals: Array<{ id?: string; terminalId?: string }> }>(
        "terminal.list",
        { worktreeId },
      );
      for (const t of terminals) {
        await m("terminal.kill", { terminalId: (t.terminalId ?? t.id) as string });
      }
    }
    await waitFor(
      async () =>
        (await worktreeOf("api", "feat/two"))?.lifecycle === "sleeping" &&
        (await worktreeOf("client", "feat/two"))?.lifecycle === "sleeping"
          ? true
          : undefined,
      { label: "both members sleep", timeoutMs: 120_000, intervalMs: 500 },
    ).catch(async (err) => {
      const hosts = await q<{ hosts: Array<{ id: string; sleepError?: string | null }> }>(
        "hosts.list",
      );
      const worker = containerOf(hostId)
        .map((c) => docker("logs", "--tail", "30", c))
        .join("\n");
      throw new Error(
        `${err.message}\nsleepError: ${hosts.hosts.find((h) => h.id === hostId)?.sleepError}\nworker log:\n${worker}`,
      );
    });
    await waitFor(async () => (containerOf(hostId).length === 0 ? true : undefined), {
      label: "the container is gone",
      timeoutMs: 60_000,
    });

    // A file read of one member wakes the host. The task comes back with both.
    const file = await q<{ content: string }>("worktree.getFile", {
      worktreeId: "api-feat-two",
      path: "hello.txt",
    });
    expect(file.content).toBe("api\nedit-api\n");
    await waitFor(
      async () =>
        (await worktreeOf("api", "feat/two"))?.lifecycle === undefined &&
        (await worktreeOf("client", "feat/two"))?.lifecycle === undefined
          ? true
          : undefined,
      { label: "both members are awake", timeoutMs: 180_000, intervalMs: 500 },
    );
    const [second] = containerOf(hostId);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    for (const repo of ["api", "client"]) {
      expect(inContainer(second as string, `cat ${folder}/${repo}/hello.txt`)).toBe(
        `${repo}\nedit-${repo}`,
      );
      expect(
        inContainer(second as string, `git -C ${folder}/${repo} rev-parse --abbrev-ref HEAD`),
      ).toBe("feat/two");
    }
    expect(inContainer(second as string, `cat ${folder}/BRIEF.md`)).toContain("two repos");
  }, 420_000);
});
