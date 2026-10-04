// Shared pieces of the environment image tests: git fixtures, the docker stub's
// state file and a small client for `environment.build` / `environment.imageStatus`.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { type ServerHandle, trpcData, trpcMutate, trpcQuery } from "./server";
import { waitFor } from "./wait-for";

export const ENV_BUILD_TOKEN = "environment-build-test-token";
export const DOCKER_STUB = join(import.meta.dirname, "..", "fixtures", "docker-stub-bin.mjs");
export const DOCKERFILE = "FROM busybox\nRUN echo toolchain\n";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

export interface Build {
  id: string;
  key: string;
  status: "building" | "ready" | "failed";
  image: string | null;
  trigger: "manual" | "auto";
  error: string | null;
  log?: string;
}

export interface ImageStatus {
  current: Build | null;
  latest: Build | null;
  builds: Build[];
}

export interface StubState {
  images: Record<string, string>;
  containers: Record<string, { image: string; script: string }>;
  calls: { tool: string; args: string[]; leaked: string[] }[];
}

export function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv });
}

/** Writes `files` and commits them on `main`. */
export function commit(repo: string, files: Record<string, string>, message: string): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-m", message);
}

export function createRepo(parent: string, name: string, files: Record<string, string>): string {
  const repo = join(parent, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  commit(repo, { "README.md": "# env build\n", ...files }, "init");
  return repo;
}

export const envFile = (env: object) => ({ ".band/environment.json": JSON.stringify(env) });

/** A client for the server and docker stub of one test file. */
export function environmentClient(getServer: () => ServerHandle, getStatePath: () => string) {
  const stub = (): StubState => JSON.parse(readFileSync(getStatePath(), "utf8"));
  const writeStub = (state: StubState) => writeFileSync(getStatePath(), JSON.stringify(state));
  const dockerCalls = (command: string) =>
    stub().calls.filter((c) => c.tool === "docker" && c.args[0] === command);

  async function build(project: string, force = false) {
    const res = await trpcMutate(
      getServer().url,
      "environment.build",
      { projectName: project, force },
      ENV_BUILD_TOKEN,
    );
    const body = await res.clone().text();
    return {
      status: res.status,
      body,
      data:
        res.status === 200
          ? await trpcData<{ build: Build; cacheHit: boolean; alreadyRunning: boolean }>(res)
          : null,
    };
  }

  async function imageStatus(project: string): Promise<ImageStatus> {
    const res = await trpcQuery(
      getServer().url,
      "environment.imageStatus",
      { projectName: project },
      ENV_BUILD_TOKEN,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    return trpcData<ImageStatus>(res);
  }

  /** Starts a build and waits until it ends. */
  async function buildAndWait(project: string, force = false): Promise<Build> {
    const started = await build(project, force);
    expect(started.status, started.body).toBe(200);
    return waitFor(
      async () => {
        const s = await imageStatus(project);
        return s.latest && s.latest.id === started.data?.build.id && s.latest.status !== "building"
          ? s.latest
          : undefined;
      },
      { label: `build of ${project} to end`, timeoutMs: 30_000, intervalMs: 100 },
    );
  }

  return { stub, writeStub, dockerCalls, build, imageStatus, buildAndWait };
}
