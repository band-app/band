// Black-box integration test for the Commits panel's tRPC procedures:
// `workspace.getCommitHistory`, `getCommitHistorySignature`,
// `getCommitDetails` and `getCommitFileDiff`.
//
// Boots the real production server (`dist/start-server.mjs`) against a tmp
// `$HOME` and drives it over real HTTP. The workspace is a real on-disk git
// repo with a merged side branch, tags, a remote-tracking ref, a rename, and
// an unmerged branch, so the history has lanes, ref decorations and pages
// to check. No mocks.

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
  trpcQuery,
} from "./helpers/server";

const TOKEN = "workspace-commit-history-token";
const WORKSPACE = "alpha-main";
const EMPTY_WORKSPACE = "empty-main";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8", stdio: "pipe" });
}

function commit(cwd: string, message: string): string {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

/**
 * main:     initial ─ rename ─────── merge ─ tip
 *                  └─ feature-work ─┘
 * side:            └─ side-work            (never merged)
 *
 * Tags: `v0.1` on initial, `v0.2` on rename. `origin/main` points at rename.
 */
function seedRepo(parent: string) {
  const path = join(parent, "alpha");
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);

  writeFileSync(join(path, "README.md"), "# alpha\n");
  writeFileSync(join(path, "old-name.txt"), "one\ntwo\nthree\nfour\nfive\n");
  const initial = commit(path, "initial");
  git(path, ["tag", "v0.1"]);

  git(path, ["checkout", "-b", "feature"]);
  writeFileSync(join(path, "feature.md"), "# feature\n");
  const featureWork = commit(path, "feature-work");

  git(path, ["checkout", "-b", "side", initial]);
  writeFileSync(join(path, "side.md"), "# side\n");
  const sideWork = commit(path, "side-work");

  git(path, ["checkout", "main"]);
  git(path, ["mv", "old-name.txt", "new-name.txt"]);
  writeFileSync(join(path, "new-name.txt"), "one\ntwo\nTHREE\nfour\nfive\n");
  const rename = commit(path, "rename");
  git(path, ["tag", "v0.2"]);
  git(path, ["update-ref", "refs/remotes/origin/main", rename]);

  git(path, ["merge", "--no-ff", "-m", "merge feature", "feature"]);
  const merge = git(path, ["rev-parse", "HEAD"]).trim();

  writeFileSync(join(path, "tip.md"), "# tip\n");
  const tip = commit(path, "tip");

  return { path, initial, featureWork, sideWork, rename, merge, tip };
}

interface CommitRef {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
}
interface HistoryCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  ts: number;
  subject: string;
  refs: CommitRef[];
}
interface HistoryPage {
  commits: HistoryCommit[];
  head: string | null;
  hasMore: boolean;
  signature: string;
}

describe("tRPC — workspace commit history", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repo: ReturnType<typeof seedRepo>;

  async function history(input: Record<string, unknown>): Promise<HistoryPage> {
    const res = await trpcQuery(server.url, "workspace.getCommitHistory", input, TOKEN);
    expect(res.status).toBe(200);
    return trpcData<HistoryPage>(res);
  }

  async function signature(): Promise<string> {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitHistorySignature",
      { workspaceId: WORKSPACE },
      TOKEN,
    );
    expect(res.status).toBe(200);
    return trpcData<string>(res);
  }

  beforeAll(async () => {
    tmpHome = createTmpHome("band-workspace-commit-history-");
    repo = seedRepo(tmpHome);
    const emptyPath = join(tmpHome, "empty");
    mkdirSync(emptyPath);
    git(emptyPath, ["init", "-b", "main"]);

    seedState(tmpHome, {
      projects: [
        {
          name: "alpha",
          path: repo.path,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo.path }],
        },
        {
          name: "empty",
          path: emptyPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: emptyPath }],
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

  it("returns 401 without a token", async () => {
    const res = await fetch(
      `${server.url}/trpc/workspace.getCommitHistory?input=${encodeURIComponent(
        JSON.stringify({ workspaceId: WORKSPACE }),
      )}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 500 for an unknown workspace", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitHistory",
      { workspaceId: "nope-main" },
      TOKEN,
    );
    expect(res.status).toBe(500);
  });

  it("returns HEAD's history in topological order with parents and ref badges", async () => {
    const page = await history({ workspaceId: WORKSPACE });

    expect(page.head).toBe(repo.tip);
    expect(page.hasMore).toBe(false);
    // The unmerged `side` branch is not part of HEAD's history.
    expect(page.commits.map((c) => c.subject)).toEqual([
      "tip",
      "merge feature",
      "feature-work",
      "rename",
      "initial",
    ]);

    const bySubject = new Map(page.commits.map((c) => [c.subject, c]));
    expect(bySubject.get("merge feature")?.parents).toEqual([repo.rename, repo.featureWork]);
    expect(bySubject.get("initial")?.parents).toEqual([]);
    expect(bySubject.get("tip")?.author).toBe("Test");
    expect(bySubject.get("tip")?.email).toBe("test@test.com");

    expect(bySubject.get("tip")?.refs).toEqual([{ name: "main", kind: "head" }]);
    expect(bySubject.get("feature-work")?.refs).toEqual([{ name: "feature", kind: "branch" }]);
    expect(bySubject.get("rename")?.refs).toEqual([
      { name: "origin/main", kind: "remote" },
      { name: "v0.2", kind: "tag" },
    ]);
    expect(bySubject.get("initial")?.refs).toEqual([{ name: "v0.1", kind: "tag" }]);
    expect(bySubject.get("merge feature")?.refs).toEqual([]);
  });

  it("pages with skip and limit, and the pages join into the full history", async () => {
    const full = await history({ workspaceId: WORKSPACE });
    const first = await history({ workspaceId: WORKSPACE, limit: 2 });
    const second = await history({ workspaceId: WORKSPACE, skip: 2, limit: 2 });
    const third = await history({ workspaceId: WORKSPACE, skip: 4, limit: 2 });

    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
    expect([...first.commits, ...second.commits, ...third.commits].map((c) => c.sha)).toEqual(
      full.commits.map((c) => c.sha),
    );
  });

  it("rejects an out-of-range limit", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitHistory",
      { workspaceId: WORKSPACE, limit: 0 },
      TOKEN,
    );
    expect(res.status).toBe(400);
  });

  it("returns an empty history for a repo with no commits", async () => {
    const page = await history({ workspaceId: EMPTY_WORKSPACE });
    expect(page).toEqual({ commits: [], head: null, hasMore: false, signature: "" });
  });

  it("changes the signature when a ref moves, and the history carries it", async () => {
    const before = await signature();
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    expect((await history({ workspaceId: WORKSPACE })).signature).toBe(before);

    git(repo.path, ["tag", "v0.3", repo.merge]);
    try {
      const after = await signature();
      expect(after).not.toBe(before);
      const page = await history({ workspaceId: WORKSPACE });
      expect(page.signature).toBe(after);
      expect(page.commits.find((c) => c.sha === repo.merge)?.refs).toEqual([
        { name: "v0.3", kind: "tag" },
      ]);
    } finally {
      git(repo.path, ["tag", "-d", "v0.3"]);
    }
  });

  it("lists a commit's changed files, reporting a rename once with its old path", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitDetails",
      { workspaceId: WORKSPACE, sha: repo.rename },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const details = await trpcData<{
      sha: string;
      subject: string;
      files: { path: string; status: string; oldPath?: string }[];
    }>(res);
    expect(details.sha).toBe(repo.rename);
    expect(details.subject).toBe("rename");
    expect(details.files).toEqual([{ path: "new-name.txt", status: "R", oldPath: "old-name.txt" }]);
  });

  it("lists a merge's files against its first parent", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitDetails",
      { workspaceId: WORKSPACE, sha: repo.merge },
      TOKEN,
    );
    const details = await trpcData<{ files: { path: string; status: string }[] }>(res);
    expect(details.files).toEqual([{ path: "feature.md", status: "A" }]);
  });

  it("diffs a renamed file against its old path", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitFileDiff",
      { workspaceId: WORKSPACE, sha: repo.rename, filePath: "new-name.txt" },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const { diff } = await trpcData<{ diff: string }>(res);
    expect(diff).toContain("rename from old-name.txt");
    expect(diff).toContain("rename to new-name.txt");
    expect(diff).toContain("-three");
    expect(diff).toContain("+THREE");
  });

  it("diffs a root commit's file as an addition, with full context on request", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitFileDiff",
      { workspaceId: WORKSPACE, sha: repo.initial, filePath: "README.md", contextLines: 99999 },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const { diff } = await trpcData<{ diff: string }>(res);
    expect(diff).toContain("new file mode");
    expect(diff).toContain("+# alpha");
  });

  it("rejects a sha that is not a hex object id", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitFileDiff",
      { workspaceId: WORKSPACE, sha: "--output=/tmp/x", filePath: "README.md" },
      TOKEN,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a file path outside the worktree", async () => {
    const res = await trpcQuery(
      server.url,
      "workspace.getCommitFileDiff",
      { workspaceId: WORKSPACE, sha: repo.initial, filePath: "../escape.txt" },
      TOKEN,
    );
    expect(res.status).toBe(500);
  });
});
