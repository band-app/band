// Integration test for the snapshot and restore hooks of the bundled `docker` runner (plan step 3.10).
// A real hub (the production bundle, temp BAND_HOME) runs `runners/docker` against a real docker
// daemon. A worktree in a container sleeps, the hub snapshots the container's /work volume into an
// image and the container goes away. A file read wakes the worktree, `restore` starts a new
// container whose /work holds the snapshot, and the files git does not keep (an untracked file, an
// ignored one and one outside the checkout) are all there.
//
// It needs what runner-docker.test.ts needs (see its header): a docker daemon, the worker image,
// and a container that reaches this machine's loopback. BAND_DOCKER_TEST_IMAGE names the image;
// without it the file is skipped, except on Linux CI (`CI=true`), where a missing image or daemon is
// a failure. The CI `docker` job runs this file, and the jobs that run the whole suite set
// BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB=1, which skips it there. The BAND_DOCKER_TEST_PORT,
// BAND_DOCKER_TEST_GIT_PORT, BAND_DOCKER_TEST_HUB_URL and BAND_DOCKER_TEST_GIT_URL variables work as
// in runner-docker.test.ts, for a docker daemon that runs in a VM.

import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { waitFor } from "./helpers/wait-for";

const IMAGE = process.env.BAND_DOCKER_TEST_IMAGE ?? "";
const NETWORK = process.env.BAND_DOCKER_TEST_NETWORK ?? "host";
const TOKEN = "docker-snapshot-shared-secret";
const RUNNER = "docker-hib";
// The container is idle this long before the hub puts it to sleep. The test writes its files first.
const IDLE_MS = 8000;

interface Worktree {
  name: string;
  path: string;
  hostId?: string;
  lifecycle?: "sleeping" | "waking";
}
interface ReposList {
  repos: Array<{ name: string; worktrees: Worktree[] }>;
}
interface SnapshotsList {
  snapshots: Array<{ id: string; hostId: string; snapshotId: string; sizeBytes: number | null }>;
}

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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

let server: ServerHandle;
let gitDaemon: ReturnType<typeof spawn> | undefined;
let hubHome: string;

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
const worktree = async (name: string) =>
  (await q<ReposList>("repos.list")).repos
    .find((p) => p.name === "proj")
    ?.worktrees.find((w) => w.name === name);
const snapshots = async () => (await q<SnapshotsList>("runners.snapshots")).snapshots;
const containerOf = (hostId: string) =>
  docker("ps", "--quiet", "--filter", `label=band.worker=${hostId}`).split("\n").filter(Boolean);
const imageExists = (image: string) => dockerHas(image);

// Linux CI has docker, so a missing image or daemon there is a broken job, not a reason to skip.
const mustRun =
  process.env.CI === "true" &&
  process.platform === "linux" &&
  !process.env.BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB;
if (mustRun && !(IMAGE && dockerHas(IMAGE))) {
  throw new Error(
    "CI on Linux requires runner-docker-snapshot.test.ts to run: set BAND_DOCKER_TEST_IMAGE to a worker image " +
      `a docker daemon has (got "${IMAGE}"), or set BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB=1 in a job that does not build it`,
  );
}

describe.skipIf(!IMAGE)("the docker hook's snapshot and restore", () => {
  beforeAll(async () => {
    hubHome = createTmpHome("band-docker-snap-hub-");
    scratch.push(hubHome);
    const origin = tmp("band-docker-snap-origin-");
    const bare = join(origin, "proj");
    mkdirSync(bare, { recursive: true });
    const seed = join(tmp("band-docker-snap-seed-"), "proj");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "hello.txt"), "hello\n");
    writeFileSync(join(seed, ".gitignore"), "ignored/\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "init");
    git(origin, "clone", "-q", "--bare", seed, bare);

    const port = Number(process.env.BAND_DOCKER_TEST_GIT_PORT) || (await freePort());
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
    const gitUrl = process.env.BAND_DOCKER_TEST_GIT_URL ?? `git://127.0.0.1:${port}`;
    git(seed, "remote", "add", "origin", `${gitUrl}/proj`);

    seedSettings(hubHome, { tokenSecret: TOKEN });
    seedState(hubHome, {
      repos: [
        {
          name: "proj",
          path: seed,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: seed }],
        },
      ],
    });
    server = await startServer({
      tmpHome: hubHome,
      remoteHost: false,
      port: Number(process.env.BAND_DOCKER_TEST_PORT) || undefined,
      env: {
        BAND_SERVE_UI: "false",
        BAND_EPHEMERAL_IDLE_TIMEOUT_MS: String(IDLE_MS),
        BAND_SNAPSHOT_SWEEP_MS: "1000",
      },
    });
    await m("settings.update", {
      runners: [
        {
          id: RUNNER,
          spawn: "bundled:docker",
          destroy: "bundled:docker",
          snapshot: "bundled:docker",
          restore: "bundled:docker",
          snapshotDelete: "bundled:docker",
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
  }, 180_000);

  afterAll(async () => {
    try {
      const left = docker("ps", "--all", "--quiet", "--filter", `label=band.runner=${RUNNER}`);
      for (const id of left.split("\n").filter(Boolean)) docker("rm", "--force", "--volumes", id);
      const images = docker("images", "--quiet", "--filter", `label=band.runner=${RUNNER}`);
      for (const id of new Set(images.split("\n").filter(Boolean))) docker("rmi", "--force", id);
    } catch {
      // Nothing to clean up.
    }
    gitDaemon?.kill();
    await server?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("keeps an untracked file through sleep and wake (S4)", async () => {
    await m("worktrees.create", {
      repo: "proj",
      branch: "snap",
      placement: { labels: { pool: RUNNER }, environment: { isolation: "container" } },
    });
    const wt = await waitFor(
      async () => {
        const found = await worktree("snap");
        return found?.hostId ? found : undefined;
      },
      { label: "worktree snap on a container", timeoutMs: 180_000, intervalMs: 500 },
    ).catch(async (err) => {
      const requests = await q<{ requests: Array<{ id: string; branch: string }> }>(
        "hostRequests.list",
      ).catch(() => ({ requests: [] }));
      const mine = requests.requests.find((r) => r.branch === "snap");
      const log = mine
        ? await q<{ log: string | null }>("runners.log", { requestId: mine.id }).catch(() => null)
        : null;
      throw new Error(
        `${err.message}\nrequest: ${JSON.stringify(mine)}\nlog:\n${log?.log ?? "(none)"}`,
      );
    });
    const hostId = wt.hostId as string;
    const [first] = containerOf(hostId);
    expect(first).toBeTruthy();

    // Work git does not hold: an untracked file, an ignored one, and a file in the worker's HOME.
    const inContainer = (c: string, script: string) => docker("exec", c, "sh", "-c", script);
    inContainer(
      first as string,
      `cd ${wt.path} && mkdir -p notes ignored && echo scratch > notes/scratch.txt && echo deps > ignored/deps.txt && echo kept > /work/home/marker.txt`,
    );

    // The hub stores the git state, snapshots /work into an image and lets the container exit.
    const taken = await waitFor(
      async () => {
        const rows = await snapshots();
        return rows.find((r) => r.hostId === hostId);
      },
      { label: "a snapshot of the container", timeoutMs: 120_000, intervalMs: 500 },
    ).catch(async (err) => {
      // Say what the hub and the worker did, so a failure explains itself.
      const hostLog = await q<{ log: string | null }>("runners.log", { requestId: hostId }).catch(
        () => null,
      );
      const workerLog = containerOf(hostId)
        .map((c) => docker("logs", "--tail", "40", c))
        .join("\n");
      throw new Error(
        `${err.message}\nhost log:\n${hostLog?.log ?? "(none)"}\nworker log:\n${workerLog || "(no container)"}`,
      );
    });
    expect(taken.snapshotId).toMatch(/^band-snapshot:/);
    expect(taken.sizeBytes).toBeGreaterThan(0);
    expect(imageExists(taken.snapshotId)).toBe(true);
    await waitFor(async () => (containerOf(hostId).length === 0 ? true : undefined), {
      label: "the container is gone",
      timeoutMs: 60_000,
    });
    expect((await worktree("snap"))?.lifecycle).toBe("sleeping");

    // A file read wakes the worktree. The restore hook starts a new container from the snapshot.
    const file = await q<{ content: string }>("worktree.getFile", {
      worktreeId: "proj-snap",
      path: "hello.txt",
    });
    expect(file.content).toBe("hello\n");
    const back = await waitFor(
      async () => {
        const found = await worktree("snap");
        return found && found.lifecycle === undefined ? found : undefined;
      },
      { label: "worktree snap is awake", timeoutMs: 120_000, intervalMs: 500 },
    );
    const [second] = containerOf(hostId);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // On a failure, say what the hooks did.
    const hostLog = async () => {
      const dir = join(hubHome, ".band", "runners", "logs");
      const logs = readdirSync(dir).map((f) => `--- ${f}\n${readFileSync(join(dir, f), "utf8")}`);
      const worker = containerOf(hostId)
        .map((c) => docker("logs", "--tail", "40", c))
        .join("\n");
      return `${logs.join("\n")}\nworker log:\n${worker}`;
    };
    const check = async (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : err}\nhost log:\n${await hostLog()}`,
        );
      }
    };
    await check(() => {
      expect(inContainer(second as string, `cat ${back.path}/notes/scratch.txt`)).toBe("scratch");
      expect(inContainer(second as string, `cat ${back.path}/ignored/deps.txt`)).toBe("deps");
      expect(inContainer(second as string, "cat /work/home/marker.txt")).toBe("kept");
    });
    // The new container runs as before, with the volume writable by its user.
    expect(inContainer(second as string, "id -u")).toBe("65532");
    inContainer(second as string, `touch ${back.path}/notes/after-restore.txt`);
    // The checkout is the same one: git sees the untracked file and no snapshot commit.
    expect(inContainer(second as string, `cd ${back.path} && git status --porcelain`)).toContain(
      "notes/",
    );
    expect(inContainer(second as string, `cd ${back.path} && git log --format=%s`)).toBe("init");

    // The snapshot is used up: the hook removes the image and the hub forgets it.
    await waitFor(
      async () =>
        (await snapshots()).length === 0 && !imageExists(taken.snapshotId) ? true : undefined,
      { label: "the used snapshot is deleted", timeoutMs: 60_000, intervalMs: 500 },
    );
  }, 420_000);
});
