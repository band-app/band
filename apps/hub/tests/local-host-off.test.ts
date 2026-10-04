// BAND_LOCAL_HOST=off: a real hub with local workspaces off and a real
// `band-worker` process. A workspace with no host goes to the worker, and a
// request for the local host is refused.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
import { waitFor } from "./helpers/wait-for";

const TOKEN = "local-host-off-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface HostView {
  id: string;
  status: string;
  usable: boolean;
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

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

let server: ServerHandle;
let worker: ChildProcess;
let workerRoot: string;
let hostId: string;

const query = async <T>(procedure: string, input?: unknown) =>
  trpcData<T>(await trpcQuery(server.url, procedure, input, TOKEN));
const mutate = (procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN);

beforeAll(async () => {
  const hubHome = createTmpHome("band-local-off-hub-");
  scratch.push(hubHome);
  workerRoot = tmp("band-local-off-root-");
  const workerState = tmp("band-local-off-state-");
  const workerHome = tmp("band-local-off-whome-");
  const hubRepo = join(tmp("band-local-off-hubrepo-"), "proj");
  makeRepo(hubRepo);
  makeRepo(join(workerRoot, "proj"));
  seedSettings(hubHome, { tokenSecret: TOKEN });
  seedState(hubHome, {
    projects: [
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
    env: { BAND_LOCAL_HOST: "off", BAND_SERVE_UI: "false" },
    // The test starts its own worker, and "the only online worker" needs exactly one.
    remoteHost: false,
  });

  const issued = await trpcData<{ token: string; hostId: string }>(
    await trpcMutate(server.url, "tokens.issueWorkerBootstrap", { hostName: "W" }, TOKEN),
  );
  hostId = issued.hostId;
  worker = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      workerRoot,
      "--state-dir",
      workerState,
    ],
    {
      env: { ...process.env, HOME: workerHome, BAND_HOME: join(workerHome, ".band") },
      stdio: "ignore",
    },
  );
  await waitFor(
    async () =>
      (await query<{ hosts: HostView[] }>("hosts.list")).hosts.find((h) => h.id === hostId)
        ?.status === "online"
        ? true
        : undefined,
    { label: "worker online", timeoutMs: 20_000 },
  );
}, 120_000);

afterAll(async () => {
  worker?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("BAND_LOCAL_HOST=off", () => {
  it("marks the local host as not usable and the worker as usable", async () => {
    const { hosts } = await query<{ hosts: HostView[] }>("hosts.list");
    expect(hosts.find((h) => h.id === "local")?.usable).toBe(false);
    expect(hosts.find((h) => h.id === hostId)?.usable).toBe(true);
  });

  it("refuses a workspace on the local host", async () => {
    const res = await mutate("workspaces.create", {
      project: "proj",
      branch: "on-local",
      hostId: "local",
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("BAND_LOCAL_HOST=off");
  });

  it("puts a workspace with no host on the only online worker", async () => {
    const res = await mutate("workspaces.create", {
      project: "proj",
      branch: "on-worker",
      hostProjectPath: join(workerRoot, "proj"),
    });
    expect(res.status).toBe(200);
    expect((await trpcData<{ path: string }>(res)).path).toBe(
      join(workerRoot, ".band-worktrees", "proj", "on-worker"),
    );
  });
});
