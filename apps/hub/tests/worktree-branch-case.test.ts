/**
 * A worktree keeps the case of its branch name. Creating one for an existing remote branch with
 * upper-case letters checks out and tracks that exact branch, and the branch-status poller finds
 * its pull request, which GitHub matches case-sensitively on `headRefName`.
 *
 * Real server, a local bare repo as `origin`, and the `gh` stub from `fixtures/gh-stub.ts`. The
 * stub answers a PR only for the exact branch name, as GitHub does.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchRepository, prNode, prUrl } from "./fixtures/branch-status-data";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import { FAKE_REPO } from "./fixtures/github-review-data";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "worktree-branch-case-token";
const REPO = "widgets";
const BRANCH = "feature/EPCNTR-4055";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" }).trim();
}

describe("worktrees.create keeps the case of a branch name", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stub: GhStub;
  let repoPath: string;
  let remoteHead: string;
  const prs: { branch: string; number: number }[] = [];

  beforeAll(async () => {
    tmpHome = createTmpHome("band-branch-case-");
    const bare = join(tmpHome, "origin.git");
    const seed = join(tmpHome, "seed");
    repoPath = join(tmpHome, REPO);
    mkdirSync(seed, { recursive: true });
    git(tmpHome, ["init", "--bare", "-b", "main", bare]);
    git(seed, ["init", "-b", "main"]);
    writeFileSync(join(seed, "README.md"), "hello\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "init"]);
    git(seed, ["remote", "add", "origin", bare]);
    git(seed, ["push", "origin", "main"]);
    git(seed, ["checkout", "-b", BRANCH]);
    writeFileSync(join(seed, "ticket.txt"), "EPCNTR-4055\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "work on the ticket"]);
    git(seed, ["push", "origin", BRANCH]);
    remoteHead = git(seed, ["rev-parse", "HEAD"]);
    git(tmpHome, ["clone", bare, repoPath]);

    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    stub = await ghStub.start();
    stub.setBranchStatusQuery(FAKE_REPO, (branch) => {
      const pr = prs.find((p) => p.branch === branch);
      return pr ? branchRepository({ pullRequests: [prNode({ number: pr.number })] }) : undefined;
    });
    server = await startServer({ tmpHome, env: stub.env });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("S1: checks out and tracks the remote branch under its exact name", async () => {
    const res = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: REPO, branch: BRANCH },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const path = join(tmpHome, ".band", "worktrees", REPO, BRANCH);
    const wt = git(repoPath, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .find((p) => p.endsWith(BRANCH));
    expect(wt, path).toBeTruthy();
    expect(git(wt as string, ["branch", "--show-current"])).toBe(BRANCH);
    expect(git(wt as string, ["rev-parse", "HEAD"])).toBe(remoteHead);
    expect(git(wt as string, ["rev-parse", "--abbrev-ref", `${BRANCH}@{upstream}`])).toBe(
      `origin/${BRANCH}`,
    );
    expect(git(repoPath, ["branch", "--list", "feature/epcntr-4055"])).toBe("");
  });

  it("S2: the poller reports the pull request of that branch", async () => {
    prs.push({ branch: BRANCH, number: 5843 });
    // The poller only queries GitHub for a github.com remote.
    git(repoPath, [
      "remote",
      "set-url",
      "origin",
      `git@github.com:${FAKE_REPO.owner}/${FAKE_REPO.name}.git`,
    ]);
    const id = testWorktreeId(REPO, BRANCH, false);
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/trpc`, {
      headers: { Cookie: `band_token=${TOKEN}` },
    });
    const numbers: number[] = [];
    ws.on("message", (raw: Buffer) => {
      const data = (
        JSON.parse(raw.toString()) as {
          result?: {
            data?: {
              kind?: string;
              worktreeId?: string;
              ci?: { pr?: { number: number; url: string } | null };
            };
          };
        }
      ).result?.data;
      if (data?.kind === "branch-status" && data.worktreeId === id && data.ci?.pr) {
        expect(data.ci.pr.url).toBe(prUrl(data.ci.pr.number));
        numbers.push(data.ci.pr.number);
      }
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
      await waitFor(() => numbers.includes(5843), { timeoutMs: 30_000 });
    } finally {
      ws.close();
    }
  }, 45_000);

  it("S3: a free-text name becomes a valid ref and keeps its case", async () => {
    const res = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: REPO, branch: "Fix Login  redirect!" },
      TOKEN,
    );
    expect(res.status).toBe(200);
    expect(git(repoPath, ["branch", "--list", "Fix-Login-redirect!"])).toContain(
      "Fix-Login-redirect!",
    );
  });

  it("refuses a name that differs only in case from an existing worktree", async () => {
    const res = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: REPO, branch: "feature/epcntr-4055" },
      TOKEN,
    );
    expect(res.status).not.toBe(200);
    expect(await res.text()).toContain("differs only in case");
  });

  it("refuses a name that differs only in case from a branch with no worktree", async () => {
    git(repoPath, ["branch", "Local/Only"]);
    const res = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: REPO, branch: "local/only" },
      TOKEN,
    );
    expect(res.status).not.toBe(200);
    expect(await res.text()).toContain("differs only in case");
    expect(git(repoPath, ["branch", "--list", "local/only"])).not.toBe("local/only");
  });

  it("refuses a name that differs only in case from a remote branch", async () => {
    // S2 pointed `origin` at github.com, so push to the bare repo by path and write the
    // remote-tracking ref directly.
    git(repoPath, ["update-ref", "refs/remotes/origin/Remote/Only", "refs/heads/main"]);
    const res = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: REPO, branch: "remote/only" },
      TOKEN,
    );
    expect(res.status).not.toBe(200);
    expect(await res.text()).toContain("differs only in case");
  });

  it("rejects an unauthenticated create", async () => {
    const res = await trpcMutate(server.url, "worktrees.create", { repo: REPO, branch: "x" }, "");
    expect(res.status).toBe(401);
  });

  it("S4: a lower-case worktree keeps its id", async () => {
    const res = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: REPO, branch: "feat/plain" },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const list = await fetch(`${server.url}/trpc/repos.list`, {
      headers: { Cookie: `band_token=${TOKEN}` },
    });
    expect(await list.text()).toContain(testWorktreeId(REPO, "feat/plain", false));
  });
});
