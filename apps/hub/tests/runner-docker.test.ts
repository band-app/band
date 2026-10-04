// Integration test for the bundled `docker` runner hook (plan step 3.6). A real
// hub (the production bundle, temp BAND_HOME) runs `runners/docker` against a
// real docker daemon. The hook starts the band-worker image in a hardened
// container, the worker dials the hub, and the workspace becomes ready on it.
//
// It needs a docker daemon, the worker image (docker/worker.Dockerfile) and a
// container that can reach this machine's loopback (`--network host` on Linux,
// which is what the CI docker job has). Set BAND_DOCKER_TEST_IMAGE to the image
// name to run it; without it the file is skipped, except on Linux CI (`CI=true`),
// where a missing image or daemon is a failure. The CI `docker` job builds the
// image and runs this file. The jobs that run the whole hub suite set
// BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB=1, which skips it there. On a machine whose docker runs
// in a VM (colima, Docker Desktop), an ssh -R tunnel can put the hub and the git
// daemon on the VM's loopback. BAND_DOCKER_TEST_PORT and BAND_DOCKER_TEST_GIT_PORT
// fix the ports they listen on here, and BAND_DOCKER_TEST_HUB_URL and
// BAND_DOCKER_TEST_GIT_URL are what the container dials (they differ from the
// listening ports because the VM forwards its own ports back to this machine). The project's origin is a
// `git daemon` on loopback, because the container clones the repository itself.

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
import { waitFor } from "./helpers/wait-for";

const IMAGE = process.env.BAND_DOCKER_TEST_IMAGE ?? "";
const NETWORK = process.env.BAND_DOCKER_TEST_NETWORK ?? "host";
const TOKEN = "docker-runner-shared-secret";

interface CreateResult {
  path: string;
  provisioning?: { requestId: string };
}
interface ProjectsList {
  projects: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
}
interface HostsList {
  hosts: Array<{ id: string; status: string }>;
}
interface Inspect {
  Config: { User: string; Labels: Record<string, string>; Image: string };
  HostConfig: {
    CapDrop: string[] | null;
    CapAdd: string[] | null;
    ReadonlyRootfs: boolean;
    SecurityOpt: string[] | null;
    PidsLimit: number | null;
    Memory: number;
    NanoCpus: number;
    AutoRemove: boolean;
    Privileged: boolean;
    Binds: string[] | null;
    NetworkMode: string;
  };
  Mounts: Array<{ Type: string; Name?: string; Destination: string }>;
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
/** Waits for a workspace. On a timeout the error carries the runner's log, which says why. */
const workspace = async (name: string) => {
  try {
    return await waitFor(
      async () =>
        (await q<ProjectsList>("projects.list")).projects
          .find((p) => p.name === "proj")
          ?.worktrees.find((w) => w.name === name),
      { label: `workspace ${name} exists`, timeoutMs: 180_000, intervalMs: 500 },
    );
  } catch (err) {
    const requests = await q<{
      requests: Array<{ id: string; branch: string; error: string | null }>;
    }>("hostRequests.list").catch(() => ({ requests: [] }));
    const mine = requests.requests.find((r) => r.branch === name);
    const log = mine
      ? await q<{ log: string | null }>("runners.log", { requestId: mine.id }).catch(() => null)
      : null;
    throw new Error(
      `${err instanceof Error ? err.message : err}\nrequest: ${JSON.stringify(mine)}\nlog:\n${log?.log ?? "(none)"}`,
    );
  }
};
const containerOf = (hostId: string) => {
  const id = docker("ps", "--quiet", "--filter", `label=band.worker=${hostId}`);
  return id.split("\n").filter(Boolean);
};

function dockerHas(image: string): boolean {
  try {
    docker("image", "inspect", image);
    return true;
  } catch {
    return false;
  }
}

// Linux CI has docker, so a missing image or daemon there is a broken job, not a reason to skip.
const mustRun =
  process.env.CI === "true" &&
  process.platform === "linux" &&
  !process.env.BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB;
if (mustRun && !(IMAGE && dockerHas(IMAGE))) {
  throw new Error(
    "CI on Linux requires runner-docker.test.ts to run: set BAND_DOCKER_TEST_IMAGE to a worker image " +
      `a docker daemon has (got "${IMAGE}"), or set BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB=1 in a job that does not build it`,
  );
}

describe.skipIf(!IMAGE)("the docker hook", () => {
  beforeAll(async () => {
    hubHome = createTmpHome("band-docker-hub-");
    scratch.push(hubHome);
    const origin = tmp("band-docker-origin-");
    const bare = join(origin, "proj");
    mkdirSync(bare, { recursive: true });
    const seed = join(tmp("band-docker-seed-"), "proj");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "hello.txt"), "hello\n");
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
      projects: [
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
      env: { BAND_SERVE_UI: "false" },
    });
    await m("settings.update", {
      runners: [
        {
          id: "docker",
          spawn: "bundled:docker",
          destroy: "bundled:docker",
          labels: { pool: "docker" },
          isolation: "container",
          maxConcurrent: 2,
          timeoutSec: 150,
          env: {
            BAND_DOCKER_IMAGE: IMAGE,
            BAND_DOCKER_NETWORK: NETWORK,
            ...(process.env.BAND_DOCKER_TEST_HUB_URL
              ? { BAND_HUB_URL: process.env.BAND_DOCKER_TEST_HUB_URL }
              : {}),
            BAND_IDLE_EXIT: "300s",
            // Hooks get a minimal environment, so a daemon that is not at the default socket is named here.
            ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
          },
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    try {
      const left = docker("ps", "--all", "--quiet", "--filter", "label=band.runner=docker");
      for (const id of left.split("\n").filter(Boolean)) docker("rm", "--force", "--volumes", id);
    } catch {
      // Nothing to clean up.
    }
    gitDaemon?.kill();
    await server?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("runs each container workspace in its own hardened container (S1, S2, S3)", async () => {
    const placement = {
      labels: { pool: "docker" },
      environment: { isolation: "container", resources: { cpu: 1, memory: "512Mi" } },
    };
    const a = await m<CreateResult>("workspaces.create", {
      project: "proj",
      branch: "docker-a",
      placement,
    });
    const b = await m<CreateResult>("workspaces.create", {
      project: "proj",
      branch: "docker-b",
      placement,
    });
    expect(a.provisioning?.requestId).toBeTruthy();
    expect(b.provisioning?.requestId).toBeTruthy();
    const [wa, wb] = await Promise.all([workspace("docker-a"), workspace("docker-b")]);
    expect(wa.hostId).not.toBe(wb.hostId);

    const hosts = (await q<HostsList>("hosts.list")).hosts;
    expect(hosts.find((h) => h.id === wa.hostId)?.status).toBe("online");

    const containers = [wa, wb].map((w) => containerOf(w.hostId as string));
    expect(containers.map((c) => c.length)).toEqual([1, 1]);
    expect(containers[0][0]).not.toBe(containers[1][0]);

    const info = JSON.parse(docker("inspect", containers[0][0]))[0] as Inspect;
    expect(info.Config.User).toBe("65532:65532");
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(info.HostConfig.CapAdd ?? []).toEqual([]);
    expect(info.HostConfig.Privileged).toBe(false);
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(info.HostConfig.PidsLimit).toBeGreaterThan(0);
    expect(info.HostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(info.HostConfig.NanoCpus).toBe(1_000_000_000);
    expect(info.HostConfig.AutoRemove).toBe(true);
    expect(info.Config.Labels).toMatchObject({
      "band.runner": "docker",
      "band.worker": wa.hostId,
    });
    expect(info.Config.Labels["band.request"]).toBeTruthy();
    expect(info.HostConfig.NetworkMode).toBe(NETWORK);
    // No bind mounts, so no docker socket and nothing else from the host.
    expect(info.HostConfig.Binds ?? []).toEqual([]);
    for (const mount of info.Mounts) expect(mount.Type).toBe("volume");
    expect(JSON.stringify(info)).not.toContain("docker.sock");

    // Inside: the uid, the read-only root and the writable /work.
    expect(docker("exec", containers[0][0], "id", "-u")).toBe("65532");
    expect(() => docker("exec", containers[0][0], "touch", "/etc/band-probe")).toThrow();
    docker("exec", containers[0][0], "touch", "/work/band-probe");
    docker("exec", containers[0][0], "touch", "/tmp/band-probe");
  }, 300_000);

  it("removes the container and its volume on destroy (S1)", async () => {
    const w = await workspace("docker-a");
    const hostId = w.hostId as string;
    const [container] = containerOf(hostId);
    expect(container).toBeTruthy();
    const volumes = (JSON.parse(docker("inspect", container))[0] as Inspect).Mounts.flatMap((mt) =>
      mt.Name ? [mt.Name] : [],
    );
    // /work, and the state volume the image declares.
    expect(volumes.length).toBeGreaterThan(0);
    const hook = join(import.meta.dirname, "../../../runners/docker/destroy.sh");
    execFileSync("sh", [hook], {
      env: { PATH: process.env.PATH ?? "", BAND_WORKER_ID: hostId },
    });
    expect(containerOf(hostId)).toEqual([]);
    // Running destroy again succeeds.
    execFileSync("sh", [hook], { env: { PATH: process.env.PATH ?? "", BAND_WORKER_ID: hostId } });
    for (const v of volumes) {
      expect(docker("volume", "ls", "--quiet", "--filter", `name=${v}`)).toBe("");
    }
  }, 60_000);

  it("runs the project's environment image, else the worker base image", async () => {
    const spawnHook = join(import.meta.dirname, "../../../runners/docker/spawn.sh");
    const destroyHook = join(import.meta.dirname, "../../../runners/docker/destroy.sh");
    const projectTag = "band-env-test/proj:ready";
    docker("tag", IMAGE, projectTag);
    const hubUrl = process.env.BAND_DOCKER_TEST_HUB_URL ?? server.url;
    const started: string[] = [];
    try {
      for (const projectImage of [projectTag, "band-env-test/proj:missing", ""]) {
        const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
          hostName: "image check",
        });
        started.push(issued.hostId);
        execFileSync("sh", [spawnHook], {
          env: {
            PATH: process.env.PATH ?? "",
            ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
            BAND_NODE: process.execPath,
            BAND_HUB_URL: hubUrl,
            BAND_WORKER_ID: issued.hostId,
            BAND_BOOTSTRAP_TOKEN: issued.token,
            BAND_DOCKER_IMAGE: IMAGE,
            BAND_DOCKER_NETWORK: NETWORK,
            BAND_PROJECT_IMAGE: projectImage,
          },
        });
        const [container] = containerOf(issued.hostId);
        const image = JSON.parse(docker("inspect", container))[0].Config.Image as string;
        expect(image).toBe(projectImage === projectTag ? projectTag : IMAGE);
      }
    } finally {
      for (const hostId of started) {
        execFileSync("sh", [destroyHook], {
          env: {
            PATH: process.env.PATH ?? "",
            ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
            BAND_WORKER_ID: hostId,
          },
        });
      }
      try {
        docker("rmi", projectTag);
      } catch {
        // Already gone.
      }
    }
  }, 120_000);
});
