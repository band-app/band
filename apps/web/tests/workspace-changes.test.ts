// Black-box integration tests for the Changes view's sections: the
// `workspace.getChanges` query (conflicts, unstaged, staged, untracked, and
// committed on the branch), the per-section `workspace.getFileDiff`, and the
// `stageFiles` / `unstageFiles` / `discardChanges` mutations.
//
// Boots the real production server against a tmp `$HOME` and real git repos
// built with the git binary. No mocks.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const TOKEN = "workspace-changes-token";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8", stdio: "pipe" });
}

/** A repo with one commit on `main` holding `files`, checked out on `main`. */
function createRepo(path: string, files: Record<string, string>): string {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content);
  git(path, ["add", "-A"]);
  git(path, ["commit", "-m", "initial"]);
  return path;
}

interface Entry {
  path: string;
  oldPath?: string;
  status: string;
  additions?: number;
  deletions?: number;
  conflict?: string;
}

interface Changes {
  headBranch: string;
  defaultBranch: string;
  compareBranch: string;
  mergeBase: string | null;
  branchStatus: string;
  conflicts: Entry[];
  unstaged: Entry[];
  staged: Entry[];
  untracked: Entry[];
  branch: Entry[];
}

let server: ServerHandle;
let tmpHome: string;
let sectionsRepo: string;
let opsRepo: string;
let conflictRepo: string;

async function getChanges(workspaceId: string, compareBranch?: string): Promise<Changes> {
  const res = await trpcQuery(
    server.url,
    "workspace.getChanges",
    { workspaceId, compareBranch },
    TOKEN,
  );
  expect(res.status).toBe(200);
  return trpcData<Changes>(res);
}

async function getFileDiff(input: Record<string, unknown>): Promise<Response> {
  return trpcQuery(server.url, "workspace.getFileDiff", input, TOKEN);
}

async function mutate(procedure: string, input: Record<string, unknown>): Promise<Response> {
  return trpcMutate(server.url, `workspace.${procedure}`, input, TOKEN);
}

beforeAll(async () => {
  tmpHome = createTmpHome("band-changes-");

  // `sections`: a feature branch with two commits on top of main, plus
  // staged, unstaged and untracked work on top of those.
  sectionsRepo = createRepo(join(tmpHome, "sections"), {
    "README.md": "# readme\n",
    "keep.txt": "keep\n",
    "rename-me.txt": "alpha\nbeta\ngamma\n",
    "gone.txt": "gone\n",
  });
  git(sectionsRepo, ["checkout", "-b", "feature"]);
  writeFileSync(join(sectionsRepo, "committed.txt"), "one\ntwo\n");
  git(sectionsRepo, ["add", "committed.txt"]);
  git(sectionsRepo, ["commit", "-m", "add committed.txt"]);
  writeFileSync(join(sectionsRepo, "README.md"), "# readme\nfeature\n");
  git(sectionsRepo, ["commit", "-am", "edit README"]);
  // Staged: an edit and a rename.
  writeFileSync(join(sectionsRepo, "keep.txt"), "keep\nstaged\n");
  git(sectionsRepo, ["add", "keep.txt"]);
  git(sectionsRepo, ["mv", "rename-me.txt", "renamed.txt"]);
  // Unstaged: a further edit to the staged file, and a deletion.
  writeFileSync(join(sectionsRepo, "keep.txt"), "keep\nstaged\nunstaged\n");
  rmSync(join(sectionsRepo, "gone.txt"));
  // Untracked: a text file in a folder and a binary file.
  mkdirSync(join(sectionsRepo, "notes"));
  writeFileSync(join(sectionsRepo, "notes/todo.md"), "line1\nline2\nline3\n");
  writeFileSync(join(sectionsRepo, "image.bin"), Buffer.from([0x89, 0x00, 0x01, 0x02]));

  // `ops`: a clean repo the stage / unstage / discard tests mutate.
  opsRepo = createRepo(join(tmpHome, "ops"), {
    "a.txt": "a\n",
    "b.txt": "b\n",
  });

  // `conflict`: a merge stopped on a conflict in c.txt.
  conflictRepo = createRepo(join(tmpHome, "conflict"), { "c.txt": "base\n" });
  git(conflictRepo, ["checkout", "-b", "feature"]);
  writeFileSync(join(conflictRepo, "c.txt"), "feature\n");
  git(conflictRepo, ["commit", "-am", "feature edit"]);
  git(conflictRepo, ["checkout", "main"]);
  writeFileSync(join(conflictRepo, "c.txt"), "main\n");
  git(conflictRepo, ["commit", "-am", "main edit"]);
  git(conflictRepo, ["checkout", "feature"]);
  expect(() => git(conflictRepo, ["merge", "main"])).toThrow();

  seedState(tmpHome, {
    projects: [
      {
        name: "sections",
        path: sectionsRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "feature", path: sectionsRepo }],
      },
      {
        name: "ops",
        path: opsRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: opsRepo }],
      },
      {
        name: "conflict",
        path: conflictRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "feature", path: conflictRepo }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  writeFileSync(join(tmpHome, ".gitconfig"), "[user]\n\tname = Test\n\temail = test@test.com\n");
  server = await startServer({ tmpHome });
});

afterAll(async () => {
  await server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("workspace.getChanges", () => {
  it("returns 401 without a token", async () => {
    const res = await fetch(
      `${server.url}/trpc/workspace.getChanges?input=${encodeURIComponent(
        JSON.stringify({ workspaceId: "sections-feature" }),
      )}`,
    );
    expect(res.status).toBe(401);
  });

  it("groups the worktree's changes into sections, keeping uncommitted work out of the branch section", async () => {
    const changes = await getChanges("sections-feature");
    const mergeBase = git(sectionsRepo, ["merge-base", "main", "HEAD"]).trim();
    expect(changes).toEqual({
      headBranch: "feature",
      defaultBranch: "main",
      compareBranch: "main",
      mergeBase,
      branchStatus: "ready",
      conflicts: [],
      unstaged: [
        { path: "gone.txt", status: "D", additions: 0, deletions: 1 },
        { path: "keep.txt", status: "M", additions: 1, deletions: 0 },
      ],
      staged: [
        { path: "keep.txt", status: "M", additions: 1, deletions: 0 },
        {
          path: "renamed.txt",
          oldPath: "rename-me.txt",
          status: "R",
          additions: 0,
          deletions: 0,
        },
      ],
      untracked: [
        { path: "image.bin", status: "U" },
        { path: "notes/todo.md", status: "U", additions: 3, deletions: 0 },
      ],
      branch: [
        { path: "committed.txt", status: "A", additions: 2, deletions: 0 },
        { path: "README.md", status: "M", additions: 1, deletions: 0 },
      ],
    });
  });

  it("reports invalid-base with an empty branch section for an unknown compare branch", async () => {
    const changes = await getChanges("sections-feature", "no-such-branch");
    expect(changes.compareBranch).toBe("no-such-branch");
    expect(changes.branchStatus).toBe("invalid-base");
    expect(changes.mergeBase).toBeNull();
    expect(changes.branch).toEqual([]);
    // The uncommitted sections don't depend on the compare branch.
    expect(changes.untracked.map((e) => e.path)).toEqual(["image.bin", "notes/todo.md"]);
  });

  it("lists an unmerged file under conflicts only", async () => {
    const changes = await getChanges("conflict-feature");
    expect(changes.conflicts).toEqual([{ path: "c.txt", status: "M", conflict: "both_modified" }]);
    expect(changes.unstaged).toEqual([]);
    expect(changes.staged).toEqual([]);
  });

  it("rejects an unknown workspace", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getChanges",
      { workspaceId: "nope-main" },
      TOKEN,
    );
    expect(res.status).toBe(500);
  });
});

describe("workspace.getFileDiff per section", () => {
  it("shows only the staged edit for the staged section", async () => {
    const res = await getFileDiff({
      workspaceId: "sections-feature",
      filePath: "keep.txt",
      section: "staged",
    });
    expect(res.status).toBe(200);
    const { diff } = await trpcData<{ diff: string }>(res);
    expect(diff).toContain("\n+staged");
    expect(diff).not.toContain("unstaged");
  });

  it("shows only the unstaged edit for the unstaged section", async () => {
    const res = await getFileDiff({
      workspaceId: "sections-feature",
      filePath: "keep.txt",
      section: "unstaged",
    });
    const { diff } = await trpcData<{ diff: string }>(res);
    expect(diff).toContain("\n+unstaged");
    expect(diff).not.toContain("\n+staged");
  });

  it("pairs both sides of a staged rename", async () => {
    const res = await getFileDiff({
      workspaceId: "sections-feature",
      filePath: "renamed.txt",
      oldPath: "rename-me.txt",
      section: "staged",
    });
    const { diff } = await trpcData<{ diff: string }>(res);
    expect(diff).toContain("rename from rename-me.txt");
    expect(diff).toContain("rename to renamed.txt");
  });

  it("shows an untracked file as all added lines", async () => {
    const res = await getFileDiff({
      workspaceId: "sections-feature",
      filePath: "notes/todo.md",
      section: "untracked",
    });
    const { diff } = await trpcData<{ diff: string }>(res);
    expect(diff).toContain("@@ -0,0 +1,3 @@\n+line1\n+line2\n+line3\n");
  });

  it("shows the committed change against the merge base for the branch section", async () => {
    const { mergeBase } = await getChanges("sections-feature");
    const res = await getFileDiff({
      workspaceId: "sections-feature",
      filePath: "README.md",
      section: "branch",
      mergeBase,
    });
    const { diff } = await trpcData<{ diff: string }>(res);
    expect(diff).toContain("\n+feature");
  });

  it("fails the branch section without a merge base", async () => {
    const res = await getFileDiff({
      workspaceId: "sections-feature",
      filePath: "README.md",
      section: "branch",
    });
    expect(res.status).toBe(500);
  });

  it("rejects a path outside the worktree", async () => {
    const res = await getFileDiff({
      workspaceId: "sections-feature",
      filePath: "../ops/a.txt",
      section: "unstaged",
    });
    expect(res.status).toBe(500);
  });
});

describe("stage, unstage and discard", () => {
  it("stages an edit and a new file", async () => {
    writeFileSync(join(opsRepo, "a.txt"), "a\nedited\n");
    writeFileSync(join(opsRepo, "new.txt"), "new\n");

    const res = await mutate("stageFiles", {
      workspaceId: "ops-main",
      paths: ["a.txt", "new.txt"],
    });
    expect(res.status).toBe(200);

    const changes = await getChanges("ops-main");
    expect(changes.staged).toEqual([
      { path: "a.txt", status: "M", additions: 1, deletions: 0 },
      { path: "new.txt", status: "A", additions: 1, deletions: 0 },
    ]);
    expect(changes.unstaged).toEqual([]);
    expect(changes.untracked).toEqual([]);
  });

  it("unstages a file back into the working tree", async () => {
    const res = await mutate("unstageFiles", { workspaceId: "ops-main", paths: ["a.txt"] });
    expect(res.status).toBe(200);

    const changes = await getChanges("ops-main");
    expect(changes.unstaged).toEqual([{ path: "a.txt", status: "M", additions: 1, deletions: 0 }]);
    expect(changes.staged.map((e) => e.path)).toEqual(["new.txt"]);
    expect(readFileSync(join(opsRepo, "a.txt"), "utf-8")).toBe("a\nedited\n");
  });

  it("discards an unstaged edit, restoring the file", async () => {
    const res = await mutate("discardChanges", {
      workspaceId: "ops-main",
      section: "unstaged",
      paths: ["a.txt"],
    });
    expect(res.status).toBe(200);

    expect(readFileSync(join(opsRepo, "a.txt"), "utf-8")).toBe("a\n");
    expect((await getChanges("ops-main")).unstaged).toEqual([]);
  });

  it("discards a staged new file, deleting it", async () => {
    const res = await mutate("discardChanges", {
      workspaceId: "ops-main",
      section: "staged",
      paths: ["new.txt"],
    });
    expect(res.status).toBe(200);

    expect(existsSync(join(opsRepo, "new.txt"))).toBe(false);
    expect((await getChanges("ops-main")).staged).toEqual([]);
  });

  it("deletes untracked files but never a tracked one passed along with them", async () => {
    writeFileSync(join(opsRepo, "junk.txt"), "junk\n");

    const res = await mutate("discardChanges", {
      workspaceId: "ops-main",
      section: "untracked",
      paths: ["junk.txt", "b.txt"],
    });
    expect(res.status).toBe(200);

    expect(existsSync(join(opsRepo, "junk.txt"))).toBe(false);
    expect(readFileSync(join(opsRepo, "b.txt"), "utf-8")).toBe("b\n");
    expect((await getChanges("ops-main")).untracked).toEqual([]);
  });

  it("marks a conflict resolved by staging it", async () => {
    writeFileSync(join(conflictRepo, "c.txt"), "resolved\n");

    const res = await mutate("stageFiles", { workspaceId: "conflict-feature", paths: ["c.txt"] });
    expect(res.status).toBe(200);

    const changes = await getChanges("conflict-feature");
    expect(changes.conflicts).toEqual([]);
    expect(changes.staged.map((e) => [e.path, e.status])).toEqual([["c.txt", "M"]]);
  });

  it("rejects an empty path list", async () => {
    const res = await mutate("stageFiles", { workspaceId: "ops-main", paths: [] });
    expect(res.status).toBe(400);
  });

  it("rejects a path starting with '-'", async () => {
    const res = await mutate("stageFiles", { workspaceId: "ops-main", paths: ["--all"] });
    expect(res.status).toBe(400);
  });

  it("rejects a path outside the worktree", async () => {
    const res = await mutate("discardChanges", {
      workspaceId: "ops-main",
      section: "unstaged",
      paths: ["../sections/keep.txt"],
    });
    expect(res.status).toBe(500);
    expect(readFileSync(join(sectionsRepo, "keep.txt"), "utf-8")).toBe("keep\nstaged\nunstaged\n");
  });
});
