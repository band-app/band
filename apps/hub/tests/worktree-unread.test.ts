// Integration test for the manual unread mark on a worktree. A real hub boots on a random port
// (auth on), the repo and worktrees are created through tRPC, and every assertion reads
// `repos.list` / `statuses.get` or the status stream, as a client does.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "worktree-unread-test-token";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function createGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(repoPath, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoPath, env: gitEnv, encoding: "utf-8" });
  git("init", "-b", "main");
  writeFileSync(join(repoPath, "README.md"), "# Test Repo\n");
  git("add", ".");
  git("commit", "-m", "initial commit");
  return repoPath;
}

describe("worktree unread mark", () => {
  let tmpHome: string;
  let server: ServerHandle;
  const MAIN = testWorktreeId("myrepo", "main");
  const OTHER = testWorktreeId("myrepo", "feat-b");

  const mutate = (procedure: string, input: unknown) =>
    trpcMutate(server.url, procedure, input, TOKEN);
  const unreadOf = async (id: string): Promise<boolean> => {
    const res = await trpcQuery(server.url, "repos.list", undefined, TOKEN);
    const data = await trpcData<{
      repos: Array<{ worktrees: Array<{ worktreeId: string; unread: boolean }> }>;
    }>(res);
    const wt = data.repos.flatMap((r) => r.worktrees).find((w) => w.worktreeId === id);
    if (!wt) throw new Error(`${id} not listed`);
    return wt.unread;
  };
  const agentStatus = async (id: string): Promise<string> => {
    const res = await trpcQuery(server.url, "statuses.get", { worktreeId: id }, TOKEN);
    return (await trpcData<{ agent: { status: string } }>(res)).agent.status;
  };

  beforeAll(async () => {
    tmpHome = createTmpHome("band-unread-test-");
    const repoPath = createGitRepo(tmpHome, "myrepo");
    // A second worktree is seeded, not created, so the remote-loopback mode moves both to the worker.
    const otherPath = join(tmpHome, "feat-b-checkout");
    execFileSync("git", ["worktree", "add", "-b", "feat-b", otherPath], {
      cwd: repoPath,
      env: gitEnv,
      encoding: "utf-8",
    });
    seedState(tmpHome, {
      repos: [
        {
          name: "myrepo",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { branch: "main", path: repoPath },
            { branch: "feat-b", path: otherPath },
          ],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });
    server = await startServer({ tmpHome });
    // A finished turn: the `done` dot Band shows today.
    const done = await mutate("statuses.update", {
      worktreeId: MAIN,
      agent: { status: "done" },
    });
    expect(done.status).toBe(200);
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("marks a worktree unread, and read again", async () => {
    expect(await unreadOf(OTHER)).toBe(false);
    expect((await mutate("worktrees.setUnread", { worktreeId: OTHER, unread: true })).status).toBe(
      200,
    );
    expect(await unreadOf(OTHER)).toBe(true);
    expect(await unreadOf(MAIN)).toBe(false);
    await mutate("worktrees.setUnread", { worktreeId: OTHER, unread: false });
    expect(await unreadOf(OTHER)).toBe(false);
  });

  it("refuses an unknown worktree", async () => {
    const res = await mutate("worktrees.setUnread", { worktreeId: "nope-main", unread: true });
    // Like the other worktree procedures, a missing worktree surfaces as a 500.
    expect(res.status).toBe(500);
  });

  it("opening a worktree clears the mark, unless the client asks to keep it", async () => {
    await mutate("worktrees.setUnread", { worktreeId: OTHER, unread: true });
    await mutate("statuses.clearNeedsAttention", { worktreeId: OTHER });
    expect(await unreadOf(OTHER)).toBe(true);
    await mutate("statuses.clearNeedsAttention", { worktreeId: OTHER, clearUnread: true });
    expect(await unreadOf(OTHER)).toBe(false);
  });

  it("marking a finished worktree read clears its done status", async () => {
    expect(await agentStatus(MAIN)).toBe("done");
    await mutate("worktrees.setUnread", { worktreeId: MAIN, unread: false });
    expect(await agentStatus(MAIN)).toBe("idle");
  });

  it("keeps the mark across a worktree sync and a hub restart", async () => {
    await mutate("worktrees.setUnread", { worktreeId: OTHER, unread: true });
    // `repos.list` reconciles with git and saves the worktree rows.
    expect(await unreadOf(OTHER)).toBe(true);
    await mutate("repos.reorder", { names: ["myrepo"] });
    expect(await unreadOf(OTHER)).toBe(true);

    await server.close();
    server = await startServer({ tmpHome });
    expect(await unreadOf(OTHER)).toBe(true);
    await mutate("worktrees.setUnread", { worktreeId: OTHER, unread: false });
  });

  it("rejects worktrees.setUnread without a token (401)", async () => {
    const res = await fetch(`${server.url}/trpc/worktrees.setUnread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeId: OTHER, unread: true }),
    });
    expect(res.status).toBe(401);
    expect(await unreadOf(OTHER)).toBe(false);
  });

  it("tells other clients through the status stream", async () => {
    const events: Array<{ kind?: string; worktreeId?: string }> = [];
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/trpc`, {
      headers: { Cookie: `band_token=${TOKEN}` },
    });
    ws.on("message", (raw: Buffer) => {
      const data = (JSON.parse(raw.toString()) as { result?: { data?: object } }).result?.data;
      if (data) events.push(data as { kind?: string; worktreeId?: string });
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "subscription",
            params: { path: "status.stream", input: undefined },
          }),
        );
        resolve();
      });
    });
    try {
      await waitFor(() => events.some((e) => e.kind === "snapshot"));
      await mutate("worktrees.setUnread", { worktreeId: OTHER, unread: true });
      await waitFor(() =>
        events.some((e) => e.kind === "worktree-origin-changed" && e.worktreeId === OTHER),
      );
      expect(await unreadOf(OTHER)).toBe(true);
    } finally {
      ws.close();
    }
  });
});
