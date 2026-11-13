/**
 * The Changes view compares a worktree against its real base when the user
 * has not picked a compare branch: the open PR's base branch, else the branch
 * the worktree was created from, else the repo's default branch. A branch the
 * user picks by hand always wins.
 *
 * Real git repo with `main`, `feat/a` and `feat/b` stacked, a real server, and
 * `gh` answered by the Express stub in `hub/tests/fixtures/gh-stub.ts` (the
 * PR badge spec shows the setup). A PR whose base is not a local branch shows
 * the existing "Can't compare" state (S6).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { branchRepository, prNode } from "../../hub/tests/fixtures/branch-status-data";
import { type GhStub, ghStub } from "../../hub/tests/fixtures/gh-stub";
import { FAKE_REPO } from "../../hub/tests/fixtures/github-review-data";
import { git, gitCommit } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChangesPanelPage } from "./pages/ChangesPanelPage";

test.use({ viewport: { width: 1920, height: 900 } });

const TOKEN = "e2e-diff-target-real-base-token";
const REPO = "stack-repo";
// feat/b has an open PR into feat/a.
const WITH_PR = "feat/b";
// feat/c was created from feat/b (stored base), no PR.
const WITH_BASE = "feat/c";
// feat/d has neither a PR nor a stored base.
const PLAIN = "feat/d";
// feat/e has a PR into a branch that does not exist locally.
const MISSING_BASE = "feat/e";

const wsId = (branch: string) => toWorktreeId(REPO, branch, "local");

let server: ServerHandle;
let stub: GhStub;
let tmpHome: string;
let prBase = "feat/a";

function commitFile(cwd: string, file: string) {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, ["add", file]);
  gitCommit(cwd, `add ${file}`);
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  commitFile(repo, "README.md");
  git(repo, [
    "remote",
    "add",
    "origin",
    `https://github.com/${FAKE_REPO.owner}/${FAKE_REPO.name}.git`,
  ]);
  git(repo, ["checkout", "-b", "feat/a"]);
  commitFile(repo, "a.txt");
  git(repo, ["checkout", "-b", WITH_PR]);
  commitFile(repo, "b.txt");
  git(repo, ["branch", WITH_BASE]);
  git(repo, ["checkout", "main"]);
  git(repo, ["branch", PLAIN]);
  git(repo, ["branch", MISSING_BASE, WITH_PR]);

  const add = (branch: string, baseBranch?: string) => {
    const path = join(tmpHome, `wt-${branch.replaceAll("/", "-")}`);
    git(repo, ["worktree", "add", path, branch]);
    return { name: branch, branch, path, ...(baseBranch && { baseBranch }) };
  };
  const worktrees = [add(WITH_PR), add(WITH_BASE, WITH_PR), add(PLAIN), add(MISSING_BASE)];
  // Give feat/c a commit of its own so "Committed on branch" has something to list.
  commitFile(worktrees[1].path, "c.txt");

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ name: "main", branch: "main", path: repo }, ...worktrees],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });

  stub = await ghStub.start();
  stub.setBranchStatusQuery(FAKE_REPO, (branch) => {
    if (branch === WITH_PR) {
      return branchRepository({ pullRequests: [prNode({ number: 801, base: prBase })] });
    }
    if (branch === MISSING_BASE) {
      return branchRepository({
        pullRequests: [prNode({ number: 802, base: "feat/not-fetched" })],
      });
    }
    return branchRepository({});
  });
  server = await startServer({ tmpHome, env: stub.env });
});

test.afterAll(async () => {
  await server?.close();
  await stub?.stop();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test.beforeEach(() => {
  prBase = "feat/a";
  resetClientState(tmpHome);
});

test("S1: an open PR's base is the default compare branch", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(wsId(WITH_PR));
  await expect(changes.diffTargetTrigger).toHaveText("feat/a", { timeout: 60_000 });
  await expect(changes.sectionRow("branch", "b.txt")).toBeVisible();
  await expect(changes.sectionRow("branch", "a.txt")).toHaveCount(0);
  await expect.poll(() => changes.compareBranch()).toBeNull();
});

test("S2: the branch the worktree was created from is the default compare branch", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(wsId(WITH_BASE));
  await expect(changes.diffTargetTrigger).toHaveText(WITH_PR, { timeout: 15_000 });
  await expect(changes.sectionRow("branch", "c.txt")).toBeVisible();
  await expect(changes.sectionRow("branch", "b.txt")).toHaveCount(0);
});

test("S3: with no PR and no stored base the default branch stays the target", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(wsId(PLAIN));
  await expect(changes.diffTargetTrigger).toHaveText("main", { timeout: 15_000 });
});

test("S4: a hand-picked branch wins, and Base branch resets it", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(wsId(WITH_BASE));
  await expect(changes.diffTargetTrigger).toHaveText(WITH_PR, { timeout: 15_000 });

  await changes.openDiffTargetDropdown();
  await changes.pickDefaultBranch();
  await expect(changes.diffTargetTrigger).toHaveText("main");
  await expect.poll(() => changes.compareBranch()).toBe("main");
  await expect(changes.sectionRow("branch", "b.txt")).toBeVisible();

  await changes.openDiffTargetDropdown();
  await changes.baseBranchButton.click();
  await expect(changes.diffTargetTrigger).toHaveText(WITH_PR);
  await expect.poll(() => changes.compareBranch()).toBeNull();
});

test("S6: a PR base that does not exist locally shows the can't compare state", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(wsId(MISSING_BASE));
  await expect(changes.diffTargetTrigger).toHaveText("feat/not-fetched", { timeout: 60_000 });
  await expect(changes.branchUnavailable).toBeVisible();
});

test("S5: the default compare branch follows a retargeted PR", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(wsId(WITH_PR));
  await expect(changes.diffTargetTrigger).toHaveText("feat/a", { timeout: 60_000 });
  prBase = "main";
  await expect(changes.diffTargetTrigger).toHaveText("main", { timeout: 90_000 });
  await expect(changes.sectionRow("branch", "a.txt")).toBeVisible();
});
