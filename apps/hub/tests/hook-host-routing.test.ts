// A hook is matched to a worktree by the host it ran on and its cwd. Two hosts
// can hold a worktree at the same path, and a hook from one must not set the
// status of the other's.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { isRemoteLoopback } from "./helpers/test-host";

const TOKEN = "hook-host-routing-token";
const LOCAL = toWorktreeId("proj", "main", "local");
const ON_B = toWorktreeId("proj", "main", "h-bbbbbbbbbbbb");

// The remote-loopback CI job runs the hub with no local host, so there is no hub-side worktree to
// share a path with host B's. That job runs the host-aware cases through the relay in
// `remote-relay.test.ts`.
describe.skipIf(isRemoteLoopback)("hook routing by host", () => {
  let server: ServerHandle;
  let home: string;
  let SHARED_PATH: string;

  beforeAll(async () => {
    home = createTmpHome("band-hook-host-");
    const hubRepo = join(home, "proj");
    // The folder is a real checkout on the hub; host B is offline, so its copy of the path is only a record.
    SHARED_PATH = hubRepo;
    mkdirSync(hubRepo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: hubRepo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    seedSettings(home, { tokenSecret: TOKEN });
    seedState(home, {
      hosts: [{ id: "h-bbbbbbbbbbbb", name: "Host B" }],
      repos: [
        {
          name: "proj",
          path: hubRepo,
          defaultBranch: "main",
          worktrees: [
            // The same path on the hub's machine and on host B.
            { branch: "main", path: SHARED_PATH },
            { branch: "main", path: SHARED_PATH, hostId: "h-bbbbbbbbbbbb" },
          ],
        },
      ],
    });
    server = await startServer({ tmpHome: home });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const notify = (input: Record<string, unknown>) =>
    trpcMutate(
      server.url,
      "statuses.notify",
      { cwd: SHARED_PATH, payload: { hook_event_name: "Stop" }, agent: "claude-code", ...input },
      TOKEN,
    );

  async function status(worktreeId: string): Promise<string | undefined> {
    const res = await trpcQuery(server.url, "statuses.get", { worktreeId }, TOKEN);
    const data = await trpcData<{ agent?: { status: string } } | null>(res);
    return data?.agent?.status;
  }

  const resolve = async (input: Record<string, unknown>) => {
    const res = await trpcQuery(
      server.url,
      "statuses.resolve",
      { cwd: SHARED_PATH, ...input },
      TOKEN,
    );
    return (await trpcData<{ worktreeId: string | null }>(res)).worktreeId;
  };

  // The hub syncs its worktrees with git a moment after boot (and on every poll). A sync once
  // dropped the hub's row because host B tracked the same path, so every later hook found nothing.
  // Running first, this case holds the other three back until that boot sync has finished.
  it("both hosts' worktrees at one path survive the sync that follows boot", async () => {
    const deadline = Date.now() + 3_000;
    do {
      expect(await resolve({})).toBe(LOCAL);
      expect(await resolve({ hostId: "h-bbbbbbbbbbbb" })).toBe(ON_B);
      await new Promise((done) => setTimeout(done, 100));
    } while (Date.now() < deadline);
  });

  it("a hook from host B sets host B's worktree and not the local one at the same path", async () => {
    expect((await notify({ hostId: "h-bbbbbbbbbbbb" })).status).toBe(200);
    expect(await status(ON_B)).toBe("done");
    expect(await status(LOCAL)).toBeUndefined();
  });

  it("a hook with no host is the hub's own machine", async () => {
    await notify({ payload: { hook_event_name: "StopFailure" } });
    expect(await status(LOCAL)).toBe("failed");
    expect(await status(ON_B)).toBe("done");
  });

  it("a hook from a host that has no worktree at the path changes nothing", async () => {
    await notify({ hostId: "h-cccccccccccc", payload: { hook_event_name: "UserPromptSubmit" } });
    expect(await status(LOCAL)).toBe("failed");
    expect(await status(ON_B)).toBe("done");
  });
});
