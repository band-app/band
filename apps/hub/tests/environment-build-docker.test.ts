// The environment image builder against a real Docker daemon (plan step 3.2).
// The stubbed flow is covered in `environment-build.test.ts`. This file checks
// what the stub cannot: that the commands the builder constructs work, that the
// worker layer and the result of `install` end up in the image, and that a second
// build is a cache hit. It skips, with the reason in the test name, when no Docker
// daemon answers or the base image cannot be pulled.
//
// Real production server, real git repo, real SQLite, temp BAND_HOME, real docker.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRepo,
  ENV_BUILD_TOKEN,
  envFile,
  environmentClient,
} from "./helpers/environment-build";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";

const BASE = "busybox:1.36";
const WORKER_BASE = `band-worker-test:${process.pid}`;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dockerReady(): boolean {
  try {
    docker("version", "--format", "{{.Server.Version}}");
    docker("image", "inspect", BASE);
    return true;
  } catch {
    try {
      docker("pull", BASE);
      return true;
    } catch {
      return false;
    }
  }
}

const available = dockerReady();
const suite = available ? describe : describe.skip;

let home: string;
let server: ServerHandle;
const { build, imageStatus, buildAndWait } = environmentClient(
  () => server,
  () => join(home, "unused-stub-state.json"),
);

suite("with a real Docker daemon", () => {
  const images: string[] = [];

  beforeAll(async () => {
    home = createTmpHome("band-env-docker-");
    // A stand-in for the worker base image: it has the files the final layer copies.
    const ctx = mkdtempSync(join(tmpdir(), "band-worker-base-"));
    writeFileSync(
      join(ctx, "Dockerfile"),
      `FROM ${BASE}\nRUN mkdir -p /usr/local/bin /opt/band-worker && cp /bin/true /usr/local/bin/node && echo worker > /opt/band-worker/marker\n`,
    );
    docker("build", "--tag", WORKER_BASE, ctx);
    images.push(WORKER_BASE);
    rmSync(ctx, { recursive: true, force: true });

    const repo = createRepo(home, "realproj", {
      ...envFile({
        build: { dockerfile: "docker/Dockerfile" },
        install: "echo installed > /workspace/installed.txt",
      }),
      "docker/Dockerfile": `FROM ${BASE}\nRUN echo toolchain > /toolchain.txt\n`,
      "pnpm-lock.yaml": "lockfileVersion: 1\n",
    });
    mkdirSync(join(home, ".band"), { recursive: true });
    seedState(home, {
      projects: [
        {
          name: "realproj",
          path: repo,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo }],
        },
      ],
    });
    seedSettings(home, {
      tokenSecret: ENV_BUILD_TOKEN,
      environmentBuilder: { workerImage: WORKER_BASE },
    });
    // The server runs with a temp HOME, so it needs to be told where the daemon
    // and the client config are.
    const host =
      process.env.DOCKER_HOST ??
      docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}").trim();
    server = await startServer({
      tmpHome: home,
      remoteHost: false,
      env: {
        DOCKER_HOST: host,
        DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"),
      },
    });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    for (const image of images) {
      try {
        docker("rmi", "--force", image);
      } catch {
        // already gone
      }
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("builds an image with the toolchain, the worker and the installed workspace, and caches it", async () => {
    const done = await buildAndWait("realproj");
    expect(done.status, `${done.error}\n${done.log}`).toBe("ready");
    const image = done.image as string;
    images.push(image);

    const run = (...cmd: string[]) =>
      docker("run", "--rm", "--entrypoint", "sh", image, "-c", cmd.join(" "));
    expect(run("cat /toolchain.txt").trim()).toBe("toolchain");
    expect(run("cat /opt/band/worker/marker").trim()).toBe("worker");
    expect(run("test -x /usr/local/bin/band-worker && echo yes").trim()).toBe("yes");
    expect(run("cat /workspace/installed.txt").trim()).toBe("installed");
    // The default-branch snapshot is in the workspace, without a .git.
    expect(run("cat /workspace/pnpm-lock.yaml").trim()).toBe("lockfileVersion: 1");
    expect(run("test -e /workspace/.git && echo git || echo none").trim()).toBe("none");
    expect(
      docker(
        "image",
        "inspect",
        "--format",
        '{{index .Config.Labels "band.environment.key"}}',
        image,
      ).trim(),
    ).toBe(done.key);

    const again = await build("realproj");
    expect(again.data?.cacheHit).toBe(true);
    expect(again.data?.build.id).toBe(done.id);
    expect((await imageStatus("realproj")).builds).toHaveLength(1);
  }, 120_000);
});
