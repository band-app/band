// Black-box integration tests for the Graph tab's commit-details reads and
// the four "essentials" write actions on `workspaceRouter`:
//   - workspace.getCommitDetails / getCommitFileDiff (read)
//   - workspace.createBranch / checkoutBranch / cherryPick / revertCommit (write)
//
// Boots the real production server (`dist/start-server.mjs`) against a tmp
// `$HOME` and drives it over real HTTP. Each write action operates on its
// OWN on-disk git repo (one project/workspace per action) so a mutation can
// never leak into another test's assertions. Every effect is verified by
// shelling out to real `git` against the repo the server just mutated. No
// mocks — the same recipe as `workspace-commit-graph.test.ts` /
// `workspace-git-ops.test.ts`.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const DEFAULT_TOKEN = "workspace-git-graph-actions-token";

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

function seedGitIdentity(tmpHome: string): void {
  writeFileSync(
    join(tmpHome, ".gitconfig"),
    [
      "[user]",
      "  name = Test",
      "  email = test@test.com",
      "[init]",
      "  defaultBranch = main",
      "",
    ].join("\n"),
    "utf-8",
  );
}

/**
 * Build a real repo with three commits across two branches:
 *
 *   main:    initial ─ second
 *   feature:         └─ feature-work
 *
 * `HEAD` ends on `main` (at `second`). Returns the repo path and the SHAs so
 * assertions can pin exact object ids.
 */
function seedRepo(
  parent: string,
  name: string,
): { path: string; initialSha: string; secondSha: string; featureSha: string } {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);

  writeFileSync(join(path, "README.md"), "# repo\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "initial"]);
  const initialSha = git(path, ["rev-parse", "HEAD"]);

  git(path, ["checkout", "-b", "feature"]);
  writeFileSync(join(path, "feature.md"), "# feature\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "feature-work"]);
  const featureSha = git(path, ["rev-parse", "HEAD"]);

  git(path, ["checkout", "main"]);
  writeFileSync(join(path, "second.md"), "# second\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "second"]);
  const secondSha = git(path, ["rev-parse", "HEAD"]);

  return { path, initialSha, secondSha, featureSha };
}

// One repo per action keeps mutations isolated within a single server boot.
const REPOS = ["reads", "createbranch", "checkout", "cherrypick", "revert"] as const;
type RepoName = (typeof REPOS)[number];

describe("tRPC — workspace Graph-tab commit details + actions", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const repos = {} as Record<RepoName, ReturnType<typeof seedRepo>>;
  const wsId = (name: RepoName) => `${name}-main`;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-git-graph-actions-");
    seedGitIdentity(tmpHome);
    for (const name of REPOS) {
      repos[name] = seedRepo(tmpHome, name);
    }

    seedState(tmpHome, {
      projects: REPOS.map((name) => ({
        name,
        path: repos[name].path,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repos[name].path }],
      })),
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── reads ──────────────────────────────────────────────────────────────

  it("getCommitDetails returns metadata + the commit's changed files", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitDetails",
      { workspaceId: wsId("reads"), sha: repos.reads.secondSha },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);

    const data = await trpcData<{
      sha: string;
      parents: string[];
      author: string;
      email: string;
      subject: string;
      files: { path: string; status: string }[];
    }>(res);

    expect(data.sha).toBe(repos.reads.secondSha);
    expect(data.parents).toEqual([repos.reads.initialSha]);
    expect(data.author).toBe("Test");
    expect(data.email).toBe("test@test.com");
    expect(data.subject).toBe("second");
    // `second` added second.md.
    expect(data.files.some((f) => f.path === "second.md" && f.status === "A")).toBe(true);
  });

  it("getCommitFileDiff returns the unified diff for one file in a commit", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitFileDiff",
      { workspaceId: wsId("reads"), sha: repos.reads.secondSha, filePath: "second.md" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ diff: string }>(res);
    expect(data.diff).toContain("second.md");
    expect(data.diff).toContain("+# second");
  });

  it("getCommitDetails rejects a non-hex sha at the transport boundary", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitDetails",
      { workspaceId: wsId("reads"), sha: "not-a-sha" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(400);
  });

  // ── createBranch ─────────────────────────────────────────────────────────

  it("createBranch creates a branch at the given sha and checks it out", async () => {
    const repo = repos.createbranch;
    const res = await trpcMutate(
      server.url,
      "workspace.createBranch",
      { workspaceId: wsId("createbranch"), sha: repo.initialSha, name: "topic", checkout: true },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    expect(await trpcData<{ ok: true }>(res)).toEqual({ ok: true });

    // The branch exists, points at `initial`, and is now the checked-out HEAD.
    expect(git(repo.path, ["rev-parse", "topic"])).toBe(repo.initialSha);
    expect(git(repo.path, ["symbolic-ref", "--short", "HEAD"])).toBe("topic");
  });

  it("createBranch rejects a branch name starting with '-'", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.createBranch",
      { workspaceId: wsId("createbranch"), sha: repos.createbranch.initialSha, name: "-evil" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(400);
  });

  // ── checkoutBranch ───────────────────────────────────────────────────────

  it("checkoutBranch switches the worktree to an existing branch", async () => {
    const repo = repos.checkout;
    expect(git(repo.path, ["symbolic-ref", "--short", "HEAD"])).toBe("main");

    const res = await trpcMutate(
      server.url,
      "workspace.checkoutBranch",
      { workspaceId: wsId("checkout"), branch: "feature" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    expect(await trpcData<{ ok: true }>(res)).toEqual({ ok: true });

    expect(git(repo.path, ["symbolic-ref", "--short", "HEAD"])).toBe("feature");
    expect(git(repo.path, ["rev-parse", "HEAD"])).toBe(repo.featureSha);
  });

  it("checkoutBranch bubbles a 500 for a branch that does not exist", async () => {
    const res = await trpcMutate(
      server.url,
      "workspace.checkoutBranch",
      { workspaceId: wsId("checkout"), branch: "does-not-exist" },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(500);
  });

  // ── cherryPick ─────────────────────────────────────────────────────────

  it("cherryPick replays a commit onto the current branch", async () => {
    const repo = repos.cherrypick;
    // HEAD is main@second; feature-work adds feature.md, which main lacks — a
    // clean, non-conflicting cherry-pick.
    const res = await trpcMutate(
      server.url,
      "workspace.cherryPick",
      { workspaceId: wsId("cherrypick"), sha: repo.featureSha },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    expect(await trpcData<{ ok: true }>(res)).toEqual({ ok: true });

    // A new tip commit reproducing feature-work now sits on main.
    expect(git(repo.path, ["log", "-1", "--format=%s"])).toBe("feature-work");
    expect(git(repo.path, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    // The picked file landed in the working tree.
    expect(git(repo.path, ["cat-file", "-t", "HEAD:feature.md"])).toBe("blob");
  });

  // ── revertCommit ─────────────────────────────────────────────────────────

  it("revertCommit creates an inverse commit that undoes the target", async () => {
    const repo = repos.revert;
    const res = await trpcMutate(
      server.url,
      "workspace.revertCommit",
      { workspaceId: wsId("revert"), sha: repo.secondSha },
      DEFAULT_TOKEN,
    );
    expect(res.status).toBe(200);
    expect(await trpcData<{ ok: true }>(res)).toEqual({ ok: true });

    // A "Revert "second"" commit is the new tip, and second.md (added by the
    // reverted commit) is gone from the tree.
    expect(git(repo.path, ["log", "-1", "--format=%s"])).toContain('Revert "second"');
    expect(() => git(repo.path, ["cat-file", "-t", "HEAD:second.md"])).toThrow();
  });
});
