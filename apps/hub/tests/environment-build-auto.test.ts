// The auto trigger of the environment image builder (plan step 3.2): a project
// that has been built is rebuilt when its lockfile or environment files change
// on the default branch, and a project that was never built is left alone.
//
// Real production server with a short poll interval, real git repos, real
// SQLite, temp BAND_HOME, and the docker stub from `fixtures/docker-stub-bin.mjs`.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  commit,
  createRepo,
  DOCKER_STUB,
  DOCKERFILE,
  ENV_BUILD_TOKEN,
  envFile,
  environmentClient,
} from "./helpers/environment-build";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

let home: string;
let server: ServerHandle;
let statePath: string;
const { imageStatus, buildAndWait } = environmentClient(
  () => server,
  () => statePath,
);

beforeAll(async () => {
  home = createTmpHome("band-env-auto-");
  statePath = join(home, "docker-stub-state.json");
  writeFileSync(statePath, JSON.stringify({ images: { "band-worker:latest": "sha256:worker-1" } }));
  const repos = {
    autoproj: createRepo(home, "autoproj", {
      ...envFile({ build: { dockerfile: "Dockerfile" } }),
      Dockerfile: DOCKERFILE,
      "go.sum": "v1\n",
    }),
    idleproj: createRepo(home, "idleproj", {
      ...envFile({ build: { dockerfile: "Dockerfile" } }),
      Dockerfile: DOCKERFILE,
      "go.sum": "v1\n",
    }),
  };
  seedState(home, {
    projects: Object.entries(repos).map(([name, path]) => ({
      name,
      path,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path }],
    })),
  });
  seedSettings(home, { tokenSecret: ENV_BUILD_TOKEN });
  server = await startServer({
    tmpHome: home,
    remoteHost: false,
    env: {
      BAND_DOCKER_BIN: DOCKER_STUB,
      STUB_DOCKER_STATE: statePath,
      BAND_ENVIRONMENT_BUILD_POLL_MS: "300",
    },
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the auto trigger", () => {
  it("rebuilds a built project when a lockfile changes on the default branch", async () => {
    const first = await buildAndWait("autoproj");
    expect(first.status, first.error ?? "").toBe("ready");
    expect(first.trigger).toBe("manual");

    commit(join(home, "autoproj"), { "go.sum": "v2\n" }, "bump go.sum");
    const auto = await waitFor(
      async () => (await imageStatus("autoproj")).builds.find((b) => b.trigger === "auto"),
      { label: "an automatic build", timeoutMs: 20_000, intervalMs: 200 },
    );
    expect(auto.key).not.toBe(first.key);
    await waitFor(
      async () => ((await imageStatus("autoproj")).current?.id === auto.id ? true : undefined),
      { label: "the automatic build to be ready", timeoutMs: 20_000, intervalMs: 200 },
    );
  });

  it("does not rebuild a key that already failed", async () => {
    commit(join(home, "autoproj"), { Dockerfile: `${DOCKERFILE}RUN FAIL_BUILD\n` }, "break");
    const failed = await waitFor(
      async () => {
        const s = await imageStatus("autoproj");
        return s.latest?.status === "failed" ? s.latest : undefined;
      },
      { label: "the automatic build to fail", timeoutMs: 20_000, intervalMs: 200 },
    );
    expect(failed.trigger).toBe("auto");
    const count = (await imageStatus("autoproj")).builds.length;
    await new Promise((r) => setTimeout(r, 1500));
    expect((await imageStatus("autoproj")).builds).toHaveLength(count);
    expect((await imageStatus("autoproj")).current?.status).toBe("ready");
  });

  it("does not build a project that was never built", async () => {
    commit(join(home, "idleproj"), { "go.sum": "v2\n" }, "bump go.sum");
    await new Promise((r) => setTimeout(r, 1500));
    expect((await imageStatus("idleproj")).builds).toHaveLength(0);
  });
});
