/**
 * A worktree's pull request set by hand: `worktrees.prSet | prClear | prGet` (what
 * `band worktrees pr set | clear | get` and the Band MCP tools call). A manual PR replaces
 * detection in the branch status, is read by number from its own repo, and is shown with state
 * `unknown` when it cannot be fetched.
 *
 * Real server, a real git repo with a github.com `origin`, and the fake `gh` (`fixtures/gh-stub`).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { branchRepository, prNode, prUrl, workflowSuite } from "./fixtures/branch-status-data";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import { FAKE_REPO } from "./fixtures/github-review-data";
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
import { waitFor } from "./helpers/wait-for";

const TOKEN = "worktree-pr-override-token";
const REPO = "widgets";
const BRANCH = "feat/detected";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });

interface PrInfo {
  source: "detected" | "manual";
  pr: { number: number; state: string; url: string; manual?: boolean; title: string } | null;
  ci: { state: string } | null;
  override: { url: string; setBy: string } | null;
}

describe("worktree pull request set by hand", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stub: GhStub;
  const worktreeId = testWorktreeId(REPO, BRANCH);

  const get = async () =>
    trpcData<PrInfo>(await trpcQuery(server.url, "worktrees.prGet", { worktreeId }, TOKEN));
  const set = (url: string) =>
    trpcMutate(server.url, "worktrees.prSet", { worktreeId, url }, TOKEN);
  const clear = () => trpcMutate(server.url, "worktrees.prClear", { worktreeId }, TOKEN);

  beforeAll(async () => {
    tmpHome = createTmpHome("band-pr-override-");
    const repo = join(tmpHome, REPO);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, [
      "remote",
      "add",
      "origin",
      `git@github.com:${FAKE_REPO.owner}/${FAKE_REPO.name}.git`,
    ]);
    const path = join(tmpHome, "wt-detected");
    git(repo, ["worktree", "add", "-b", BRANCH, path]);
    // A fork the branch pushes to.
    git(repo, ["remote", "add", "fork", "git@github.com:someone/widgets.git"]);
    git(repo, ["config", `branch.${BRANCH}.pushRemote`, "fork"]);
    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: repo,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: repo },
            { name: BRANCH, branch: BRANCH, path },
          ],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    stub = await ghStub.start();
    // Detection finds nothing for the branch; PR 93 exists with a passing head commit, 94 does not.
    stub.setBranchStatusQuery(FAKE_REPO, () =>
      branchRepository({ suites: [workflowSuite({ workflow: "CI" })] }),
    );
    stub.setPullRequestQuery(FAKE_REPO, (number) =>
      number === 93
        ? {
            ...prNode({ number: 93, title: "chosen by hand", base: "main" }),
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
          }
        : undefined,
    );
    stub.setPullRequestQuery({ owner: "someone", name: "widgets" }, (number) =>
      number === 7 ? prNode({ number: 7, title: "from the push remote" }) : undefined,
    );
    server = await startServer({ tmpHome, env: stub.env });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("S3: rejects a URL that is not a pull request and stores nothing", async () => {
    for (const bad of ["not a url", "https://github.com/o/r/issues/93", "https://example.com/"]) {
      const res = await set(bad);
      expect(res.status).toBe(400);
    }
    expect((await get()).source).toBe("detected");
  });

  it("rejects set and clear without a valid token and changes nothing", async () => {
    const before = await get();
    const bad = await trpcMutate(
      server.url,
      "worktrees.prSet",
      { worktreeId, url: prUrl(93) },
      "wrong",
    );
    expect(bad.status).toBe(401);
    const bad2 = await trpcMutate(server.url, "worktrees.prClear", { worktreeId }, "wrong");
    expect(bad2.status).toBe(401);
    expect((await get()).source).toBe(before.source);
  });

  it("rejects a PR in a repo that is not the worktree's repo, its upstream or its push remote", async () => {
    const res = await set("https://github.com/stranger/other/pull/5");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("not in this worktree's repository");
    expect((await get()).source).toBe("detected");
  });

  it("accepts a PR in the repo the branch pushes to", async () => {
    expect((await set("https://github.com/someone/widgets/pull/7")).status).toBe(200);
    expect((await get()).pr).toMatchObject({ number: 7, manual: true });
    expect((await clear()).status).toBe(200);
  });

  it("S1: set stores the PR as manual and the status carries its number, url, state and CI", async () => {
    const res = await set(prUrl(93));
    expect(res.status).toBe(200);
    const info = await get();
    expect(info.source).toBe("manual");
    expect(info.override?.url).toBe(prUrl(93));
    expect(info.override?.setBy).toBe("user");
    expect(info.pr).toMatchObject({
      number: 93,
      title: "chosen by hand",
      url: prUrl(93),
      state: "open",
      manual: true,
    });
    expect(info.ci?.state).toBe("success");
  });

  it("a PR that cannot be fetched is shown with state unknown, not dropped", async () => {
    expect((await set("https://github.com/acme/widgets/pull/94")).status).toBe(200);
    const info = await get();
    expect(info.pr).toMatchObject({ number: 94, state: "unknown", manual: true });
  });

  it("S2: clear returns the worktree to detected behaviour", async () => {
    expect((await clear()).status).toBe(200);
    await waitFor(async () => (await get()).pr === null, { timeoutMs: 10_000 });
    const info = await get();
    expect(info).toMatchObject({ source: "detected", override: null, pr: null });
  });
});
