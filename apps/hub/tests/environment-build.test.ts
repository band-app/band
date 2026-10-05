// Integration tests for environment images (plan step 3.2): the builder
// computes a key from the environment file, what it references, the lockfiles
// and the worker base, builds an image on the builder host, reuses a ready
// image for the same key, and never lets a failed build replace the last ready
// one. `devcontainer` and `image` environments take their own build commands.
//
// Real production server, real git repos, real SQLite, temp BAND_HOME. Docker
// is the external service: the server runs `fixtures/docker-stub-bin.mjs` in
// place of `docker` and `devcontainer` (`BAND_DOCKER_BIN`, `BAND_DEVCONTAINER_BIN`),
// which keeps the images it "builds" in a JSON file. `environment-build-docker.test.ts`
// runs the same flow against a real Docker daemon.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Build,
  commit,
  createRepo,
  DOCKER_STUB,
  DOCKERFILE,
  ENV_BUILD_TOKEN,
  envFile,
  environmentClient,
  git,
} from "./helpers/environment-build";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = ENV_BUILD_TOKEN;

let home: string;
let server: ServerHandle;
let statePath: string;
const { stub, writeStub, dockerCalls, build, imageStatus, buildAndWait } = environmentClient(
  () => server,
  () => statePath,
);

beforeAll(async () => {
  home = createTmpHome("band-env-build-");
  statePath = join(home, "docker-stub-state.json");
  writeFileSync(statePath, JSON.stringify({ images: { "band-worker:latest": "sha256:worker-1" } }));

  const repos: Record<string, string> = {
    dockerproj: createRepo(home, "dockerproj", {
      ...envFile({ build: { dockerfile: "docker/Dockerfile" }, install: "pnpm install" }),
      "docker/Dockerfile": DOCKERFILE,
      "pnpm-lock.yaml": "lockfileVersion: 1\n",
    }),
    cacheproj: createRepo(home, "cacheproj", {
      ...envFile({ build: { dockerfile: "docker/Dockerfile" }, install: "pnpm install" }),
      "docker/Dockerfile": DOCKERFILE,
      "pnpm-lock.yaml": "lockfileVersion: 1\n",
    }),
    devproj: createRepo(home, "devproj", {
      ...envFile({ build: { devcontainer: ".devcontainer/devcontainer.json" }, install: "npm ci" }),
      ".devcontainer/devcontainer.json": '{ "image": "node:24" }\n',
    }),
    imageproj: createRepo(home, "imageproj", envFile({ build: { image: "node:24" } })),
    nobuildproj: createRepo(home, "nobuildproj", envFile({ install: "echo hi" })),
    noenvproj: createRepo(home, "noenvproj", {}),
  };
  seedState(home, {
    repos: Object.entries(repos).map(([name, path]) => ({
      name,
      path,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path }],
    })),
  });
  seedSettings(home, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: home,
    remoteHost: false,
    env: {
      BAND_DOCKER_BIN: DOCKER_STUB,
      BAND_DEVCONTAINER_BIN: DOCKER_STUB,
      STUB_DOCKER_STATE: statePath,
      // The auto trigger has its own test file, so a tick never races these builds.
      BAND_ENVIRONMENT_BUILD_POLL_MS: "3600000",
      // A credential in the hub's environment must not reach the build commands.
      GITHUB_TOKEN: "hub-secret-token",
    },
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a dockerfile environment", () => {
  it("builds an image, and a second build with no changes is a cache hit", async () => {
    const done = await buildAndWait("cacheproj");
    expect(done.status, done.error ?? "").toBe("ready");
    expect(done.image).toMatch(/^band-env\/cacheproj:[0-9a-f]{16}$/);
    expect(done.log).toContain("docker build");
    expect(done.log).toContain("docker commit");

    // The toolchain, the worker layer and install each ran once.
    const builds = dockerCalls("build").length;
    expect(builds).toBe(2);
    const container = Object.values(stub().containers);
    expect(container).toHaveLength(0); // removed after the commit
    expect(dockerCalls("create").some((c) => c.args.includes("pnpm install"))).toBe(true);

    const again = await build("cacheproj");
    expect(again.status, again.body).toBe(200);
    expect(again.data?.cacheHit).toBe(true);
    expect(again.data?.build.id).toBe(done.id);
    expect(dockerCalls("build")).toHaveLength(builds);
    expect((await imageStatus("cacheproj")).builds).toHaveLength(1);
  });

  it("rebuilds when the image was removed from the host", async () => {
    const first = (await imageStatus("cacheproj")).current as Build;
    const state = stub();
    delete state.images[first.image as string];
    writeStub(state);
    const second = await buildAndWait("cacheproj");
    expect(second.status).toBe("ready");
    expect(second.id).not.toBe(first.id);
    expect(second.key).toBe(first.key);
  });

  it("builds from the default branch, not from uncommitted files", async () => {
    const before = (await imageStatus("dockerproj")).builds.length;
    writeFileSync(join(home, "dockerproj", "pnpm-lock.yaml"), "uncommitted\n");
    const done = await buildAndWait("dockerproj");
    expect(done.status).toBe("ready");
    expect((await imageStatus("dockerproj")).builds).toHaveLength(before + 1);
    git(join(home, "dockerproj"), "checkout", "--", "pnpm-lock.yaml");
  });

  it("keeps the previous ready image as current when a build fails, and a changed lockfile gets a new key", async () => {
    const repo = join(home, "dockerproj");
    const first = (await imageStatus("dockerproj")).current as Build;
    expect(first.status).toBe("ready");

    // A changed lockfile is a new key, and builds again.
    commit(repo, { "pnpm-lock.yaml": "lockfileVersion: 2\n" }, "bump lock");
    const second = await buildAndWait("dockerproj");
    expect(second.status, second.error ?? "").toBe("ready");
    expect(second.key).not.toBe(first.key);
    expect(second.image).not.toBe(first.image);
    expect((await imageStatus("dockerproj")).current?.id).toBe(second.id);

    // A failing build does not replace it.
    commit(repo, { "docker/Dockerfile": `${DOCKERFILE}RUN FAIL_BUILD\n` }, "break the toolchain");
    const failed = await buildAndWait("dockerproj");
    expect(failed.status).toBe("failed");
    expect(failed.key).not.toBe(second.key);
    expect(failed.error).toContain("docker build failed");
    expect(failed.log).toContain("FAIL_BUILD");
    expect(failed.image).toBeNull();
    const status = await imageStatus("dockerproj");
    expect(status.current?.id).toBe(second.id);
    expect(status.current?.image).toBe(second.image);
    expect(status.latest?.id).toBe(failed.id);

    // A failing install does not either.
    commit(repo, { "docker/Dockerfile": DOCKERFILE }, "fix the toolchain");
    commit(
      repo,
      envFile({ build: { dockerfile: "docker/Dockerfile" }, install: "FAIL_INSTALL" }),
      "break install",
    );
    const installFailed = await buildAndWait("dockerproj");
    expect(installFailed.status).toBe("failed");
    expect(installFailed.log).toContain("FAIL_INSTALL");
    expect((await imageStatus("dockerproj")).current?.id).toBe(second.id);
  });

  it("changes the key when the worker base image changes", async () => {
    const before = (await imageStatus("cacheproj")).current as Build;
    const state = stub();
    state.images["band-worker:latest"] = "sha256:worker-2";
    writeStub(state);
    const done = await buildAndWait("cacheproj");
    expect(done.status).toBe("ready");
    expect(done.key).not.toBe(before.key);
  });

  it("starts one build at a time per repo", async () => {
    commit(join(home, "cacheproj"), { "pnpm-lock.yaml": "lockfileVersion: 3\n" }, "bump lock");
    const [a, b] = await Promise.all([build("cacheproj"), build("cacheproj")]);
    expect(a.status, a.body).toBe(200);
    expect(b.status, b.body).toBe(200);
    expect(a.data?.build.id).toBe(b.data?.build.id);
    await waitFor(
      async () => ((await imageStatus("cacheproj")).latest?.status === "ready" ? true : undefined),
      { label: "build to end", timeoutMs: 30_000, intervalMs: 100 },
    );
  });

  it("never passes the hub's credentials to the build commands", async () => {
    const done = await buildAndWait("cacheproj", true);
    expect(done.status, done.error ?? "").toBe("ready");
    const calls = stub().calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.flatMap((c) => c.leaked)).toEqual([]);
  });
});

describe("other environments", () => {
  it("builds a devcontainer environment with the devcontainers CLI", async () => {
    const done = await buildAndWait("devproj");
    expect(done.status, done.error ?? "").toBe("ready");
    const call = stub().calls.find((c) => c.tool === "devcontainer");
    expect(call?.args).toEqual(
      expect.arrayContaining(["build", "--workspace-folder", "--config", "--image-name"]),
    );
    expect(call?.args.join(" ")).toContain(".devcontainer/devcontainer.json");
  });

  it("pulls the image of an image environment and skips install when there is none", async () => {
    const done = await buildAndWait("imageproj");
    expect(done.status, done.error ?? "").toBe("ready");
    expect(dockerCalls("pull").some((c) => c.args.includes("node:24"))).toBe(true);
    expect(done.log).toContain("docker tag");
  });
});

describe("refusals", () => {
  it("answers 401 without a token and 403 to a non-admin device token", async () => {
    const anonymous = await trpcMutate(
      server.url,
      "environment.build",
      { repoName: "cacheproj" },
      undefined,
    );
    expect(anonymous.status).toBe(401);

    const created = await trpcMutate(server.url, "tokens.createDevice", { label: "phone" }, TOKEN);
    expect(created.status).toBe(200);
    const { token } = await trpcData<{ token: string }>(created);
    const device = await trpcMutate(
      server.url,
      "environment.build",
      { repoName: "cacheproj" },
      token,
    );
    expect(device.status).toBe(403);

    const settings = await trpcMutate(
      server.url,
      "settings.update",
      { environmentBuilder: { registry: "evil.example.com" } },
      token,
    );
    expect(settings.status).toBe(403);
  });

  it("refuses an environment with no build", async () => {
    const res = await build("nobuildproj");
    expect(res.status).toBe(400);
    expect(res.body).toContain("Set build.devcontainer, build.dockerfile or build.image");
  });

  it("refuses a repo with no environment file", async () => {
    const res = await build("noenvproj");
    expect(res.status).toBe(400);
    expect(res.body).toContain("does not exist");
  });

  it("refuses an unknown repo", async () => {
    const res = await build("nope");
    expect(res.status).toBe(404);
  });

  it("says how to get the worker base image when the host has none", async () => {
    const state = stub();
    const worker = state.images["band-worker:latest"];
    delete state.images["band-worker:latest"];
    writeStub(state);
    try {
      const res = await build("cacheproj");
      expect(res.status).toBe(412);
      expect(res.body).toContain("docker build -f docker/worker.Dockerfile");
    } finally {
      state.images["band-worker:latest"] = worker;
      writeStub(state);
    }
  });
});
