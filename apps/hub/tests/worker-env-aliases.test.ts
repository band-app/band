// BAND_LOCAL_WORKER and BAND_DEFAULT_WORKER are the new names of BAND_LOCAL_HOST and
// BAND_DEFAULT_HOST. A real hub reads the new name first and falls back to the old one.
// Each case boots its own hub, because both variables are read from the hub's environment.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const TOKEN = "worker-env-aliases-secret";
const VARIABLES = [
  "BAND_LOCAL_WORKER",
  "BAND_LOCAL_HOST",
  "BAND_DEFAULT_WORKER",
  "BAND_DEFAULT_HOST",
] as const;

const scratch: string[] = [];
const servers: ServerHandle[] = [];
const saved: Record<string, string | undefined> = {};

function makeRepo(dir: string): void {
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

async function hub(env: Record<string, string>): Promise<ServerHandle> {
  const home = createTmpHome("band-worker-env-");
  scratch.push(home);
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "band-worker-env-repo-"))), "proj");
  scratch.push(join(repo, ".."));
  makeRepo(repo);
  seedSettings(home, { tokenSecret: TOKEN });
  seedState(home, {
    repos: [
      {
        name: "proj",
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  const server = await startServer({
    tmpHome: home,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false", ...env },
  });
  servers.push(server);
  return server;
}

const hostIds = async (server: ServerHandle): Promise<string[]> => {
  const res = await trpcQuery(server.url, "workers.list", undefined, TOKEN);
  expect(res.status).toBe(200);
  return (await trpcData<{ hosts: Array<{ id: string }> }>(res)).hosts.map((h) => h.id);
};

const createOn = async (server: ServerHandle, branch: string) => {
  const res = await trpcMutate(server.url, "worktrees.create", { repo: "proj", branch }, TOKEN);
  return { status: res.status, text: await res.text() };
};

beforeAll(() => {
  // The tests set these per hub. A value inherited from the session would win over the old name.
  for (const name of VARIABLES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterAll(async () => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await Promise.all(servers.map((s) => s.close()));
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("BAND_LOCAL_WORKER and BAND_LOCAL_HOST", () => {
  it("BAND_LOCAL_WORKER=off turns the hub's own machine off", async () => {
    const server = await hub({ BAND_LOCAL_WORKER: "off" });
    expect(await hostIds(server)).not.toContain("local");
  }, 60_000);

  it("BAND_LOCAL_HOST=off still turns it off when the new name is unset", async () => {
    const server = await hub({ BAND_LOCAL_HOST: "off" });
    expect(await hostIds(server)).not.toContain("local");
  }, 60_000);

  it("the new name wins: BAND_LOCAL_WORKER=off with BAND_LOCAL_HOST=on keeps it off", async () => {
    const server = await hub({ BAND_LOCAL_WORKER: "off", BAND_LOCAL_HOST: "on" });
    expect(await hostIds(server)).not.toContain("local");
  }, 60_000);

  it("an empty BAND_LOCAL_WORKER does not hide BAND_LOCAL_HOST=off", async () => {
    const server = await hub({ BAND_LOCAL_WORKER: "", BAND_LOCAL_HOST: "off" });
    expect(await hostIds(server)).not.toContain("local");
  }, 60_000);
});

describe("BAND_DEFAULT_WORKER and BAND_DEFAULT_HOST", () => {
  // With the hub's machine off and no worker online, naming the local machine as the default is
  // refused with the "turned off" message. Any other default fails differently, so the message
  // shows which variable the hub read.
  it("reads BAND_DEFAULT_WORKER", async () => {
    const server = await hub({ BAND_LOCAL_WORKER: "off", BAND_DEFAULT_WORKER: "local" });
    const res = await createOn(server, "via-new");
    expect(res.status).toBe(500);
    expect(res.text).toContain("turned off");
  }, 60_000);

  it("reads BAND_DEFAULT_HOST when the new name is unset", async () => {
    const server = await hub({ BAND_LOCAL_HOST: "off", BAND_DEFAULT_HOST: "local" });
    const res = await createOn(server, "via-old");
    expect(res.status).toBe(500);
    expect(res.text).toContain("turned off");
  }, 60_000);

  it("the new name wins when both are set", async () => {
    const server = await hub({
      BAND_LOCAL_WORKER: "off",
      BAND_DEFAULT_WORKER: "h-nosuchworker",
      BAND_DEFAULT_HOST: "local",
    });
    const res = await createOn(server, "both");
    expect(res.status).toBe(500);
    expect(res.text).not.toContain("turned off");
  }, 60_000);

  it("reports that no worker is online when neither is set", async () => {
    const server = await hub({ BAND_LOCAL_WORKER: "off" });
    const res = await createOn(server, "none");
    expect(res.status).toBe(500);
    expect(res.text).toContain("No worker is online");
  }, 60_000);
});
