// Black-box regression for the "branch disappears from project branches"
// bug. When the branch checked out inside a worktree is switched (by an
// agent, a person, or a terminal `git switch`), the worktree used to vanish
// from `projects.list` until the app was restarted / state was rewritten —
// because the list intersected git's live view against tracked worktrees by
// BRANCH NAME, and the switched worktree's new branch wasn't in the tracked
// set. The fix keys that intersection by the worktree PATH (its stable
// identity) and carries the frozen `workspaceId` over, so the card stays
// present and surfaces git's live branch.
//
// Boots the real production server against a tmp `$HOME` with a real on-disk
// git repo + worktree, drives `projects.list` over real HTTP, and asserts on
// the response — no mocks. Mirrors the setup style of
// `workspace-git-ops.test.ts`.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWorkspaceId } from "../src/dashboard";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "projects-branch-switch-token";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

interface ListedWorktree {
  workspaceId: string;
  branch: string;
  path: string;
}
interface ListedProject {
  name: string;
  worktrees: ListedWorktree[];
}

describe("tRPC — projects.list across a worktree branch switch", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;
  let wtPath: string;

  const featureId = toWorkspaceId("alpha", "feature");

  beforeAll(async () => {
    tmpHome = createTmpHome("band-projects-branch-switch-");

    // Real git repo with a real secondary worktree on `feature`.
    repoPath = join(tmpHome, "alpha");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "file.txt"), "hello");
    git(repoPath, ["add", "file.txt"]);
    git(repoPath, ["commit", "-m", "initial"]);

    wtPath = join(tmpHome, "wt-feature");
    git(repoPath, ["worktree", "add", "-b", "feature", wtPath]);

    seedState(tmpHome, {
      projects: [
        {
          name: "alpha",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { branch: "main", path: repoPath },
            { branch: "feature", path: wtPath },
          ],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function listAlpha(): Promise<ListedProject> {
    const res = await trpcQuery(server.url, "projects.list", undefined, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{ projects: ListedProject[] }>(res);
    const alpha = data.projects.find((p) => p.name === "alpha");
    expect(alpha).toBeDefined();
    return alpha!;
  }

  it("returns 401 without a token", async () => {
    const res = await fetch(`${server.url}/trpc/projects.list`);
    expect(res.status).toBe(401);
  });

  it("lists the feature worktree with its frozen id before any switch", async () => {
    const alpha = await listAlpha();
    const feature = alpha.worktrees.find((wt) => wt.path === wtPath);
    expect(feature).toBeDefined();
    expect(feature!.workspaceId).toBe(featureId);
    expect(feature!.branch).toBe("feature");
  });

  it("keeps the worktree visible (same id, live branch) after its branch is switched", async () => {
    // The branch checked out inside the worktree changes out from under Band.
    git(wtPath, ["switch", "-c", "feature-renamed"]);

    const alpha = await listAlpha();

    // The worktree must not have vanished — the whole bug was a missing card.
    // Assert the count is unchanged so a disappearing worktree fails here even
    // if no duplicate appears under the old branch.
    expect(alpha.worktrees).toHaveLength(2);

    // The worktree must still be present — keyed by its stable path, not the
    // branch that just changed.
    const feature = alpha.worktrees.find((wt) => wt.path === wtPath);
    expect(feature).toBeDefined();
    // Its workspace identity is frozen at the value minted on creation ...
    expect(feature!.workspaceId).toBe(featureId);
    // ... and the list now surfaces git's live branch label.
    expect(feature!.branch).toBe("feature-renamed");

    // And there is no phantom entry under the old branch name.
    const stillFeature = alpha.worktrees.filter((wt) => wt.branch === "feature");
    expect(stillFeature).toHaveLength(0);
  });
});
