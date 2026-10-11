// Black-box integration tests for plain (non-git) repos (#427).
//
// The web server is spawned the same way as in `trpc.test.ts` — real
// SQLite under a tmpdir HOME, real HTTP, real filesystem. No mocks. Each
// describe block gets its own server so the test cases stay independent.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countBranchStatusRows, readRepoKind, seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome as createCanonicalTmpHome,
  type ServerHandle,
  startServer as startCanonicalServer,
} from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { removeTmpHome } from "./helpers/tmp-home";

const DEFAULT_TOKEN = "plain-repos-token";

// ---------------------------------------------------------------------------
// Local copies of the helpers from trpc.test.ts — duplicated rather than
// extracted to keep test files self-contained (per repo convention; the
// existing test files each carry their own copies too).
// ---------------------------------------------------------------------------

function createTmpHome(): string {
  return createCanonicalTmpHome("band-plain-test-");
}

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  return startCanonicalServer({ tmpHome: opts.tmpHome || createTmpHome(), env: opts.env });
}

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: defaultHeaders });
}

async function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

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

function createPlainDir(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "notes.md"), "# Notes\n");
  return path;
}

// ---------------------------------------------------------------------------
// Adding plain repos
// ---------------------------------------------------------------------------

describe("tRPC — plain repos (add)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;
  let gitRepoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "scratch");

    // A real git repo to verify the discriminator still picks "git".
    gitRepoPath = join(tmpHome, "real-repo");
    mkdirSync(gitRepoPath, { recursive: true });
    git(gitRepoPath, ["init", "-b", "main"]);
    writeFileSync(join(gitRepoPath, "README.md"), "# real-repo\n");
    git(gitRepoPath, ["add", "."]);
    git(gitRepoPath, ["commit", "-m", "initial"]);

    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("repos.add registers a plain folder with kind='plain'", async () => {
    const res = await trpcMutate(server.url, "repos.add", { path: plainPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      name: string;
      path: string;
      kind: "git" | "plain";
      worktrees: Array<{ branch: string; path: string }>;
    }>(res);
    expect(data.name).toBe("scratch");
    expect(data.kind).toBe("plain");
    // Plain repos get a single implicit worktree whose path equals
    // the repo path — no worktrees directory, no clone, no copy.
    expect(data.worktrees).toHaveLength(1);
    expect(data.worktrees[0].branch).toBe("main");
    expect(data.worktrees[0].path).toBe(plainPath);
  });

  it("repos.add registers a git repo with kind='git'", async () => {
    const res = await trpcMutate(server.url, "repos.add", { path: gitRepoPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ name: string; kind: "git" | "plain" }>(res);
    expect(data.name).toBe("real-repo");
    expect(data.kind).toBe("git");
  });

  it("repos.list returns the kind field for each repo", async () => {
    const res = await trpcQuery(server.url, "repos.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{
      repos: Array<{ name: string; kind?: "git" | "plain" }>;
    }>(res);
    const scratch = data.repos.find((p) => p.name === "scratch");
    const realRepo = data.repos.find((p) => p.name === "real-repo");
    expect(scratch?.kind).toBe("plain");
    expect(realRepo?.kind).toBe("git");
  });

  it("repos.list returns the implicit worktree for plain repos", async () => {
    const res = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{
      repos: Array<{
        name: string;
        worktrees: Array<{ branch: string; path: string; worktreeId: string }>;
      }>;
    }>(res);
    const scratch = data.repos.find((p) => p.name === "scratch")!;
    expect(scratch.worktrees).toHaveLength(1);
    expect(scratch.worktrees[0].branch).toBe("main");
    expect(scratch.worktrees[0].path).toBe(plainPath);
    expect(scratch.worktrees[0].worktreeId).toBe(toWorktreeId("scratch", "main", "local"));
  });
});

// ---------------------------------------------------------------------------
// repos.list self-heals `kind` from the filesystem
// ---------------------------------------------------------------------------
//
// The schema migration for #427 set `DEFAULT 'git'` for every pre-existing
// row, so a repo added before this PR shipped — and sitting in a plain
// folder — would otherwise stay incorrectly tagged. `repos.list` must
// re-detect kind from the on-disk state and persist the correction.

describe("tRPC — plain repos (self-heal kind)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "scratch");

    // Seed the row as it would look post-migration: kind="git" (the default
    // applied by the ALTER TABLE) but empty worktrees (the pre-PR add code
    // couldn't enumerate git worktrees in a non-git folder).
    seedState(tmpHome, {
      repos: [
        {
          name: "scratch",
          path: plainPath,
          defaultBranch: "main",
          kind: "git",
          worktrees: [],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("re-detects kind=plain when the folder has no .git", async () => {
    const res = await trpcQuery(server.url, "repos.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{
      repos: Array<{
        name: string;
        kind: "git" | "plain";
        worktrees: Array<{ branch: string; path: string }>;
      }>;
    }>(res);
    const scratch = data.repos.find((p) => p.name === "scratch")!;
    expect(scratch.kind).toBe("plain");
    // Self-heal also synthesizes the implicit worktree that pre-PR rows
    // would have lacked, so the flattened plain UI has something to render.
    expect(scratch.worktrees).toHaveLength(1);
    expect(scratch.worktrees[0].branch).toBe("main");
    expect(scratch.worktrees[0].path).toBe(plainPath);
  });

  it("worktree mutations on the self-healed repo are now plain-gated", async () => {
    // Confirm the heal persisted: a worktree mutation that checks
    // `repo.kind === "plain"` must now reject (it wouldn't have before
    // the heal, because the stored kind was "git").
    const res = await trpcMutate(server.url, "worktrees.create", {
      repo: "scratch",
      branch: "feature-1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git/i);
  });
});

// ---------------------------------------------------------------------------
// `git → plain` self-heal with pre-existing worktrees
// ---------------------------------------------------------------------------
//
// A user `rm -rf .git`-ing a real git repo: the self-heal must replace
// the (now-orphaned) git-style worktrees with the implicit `main` worktree,
// not just leave them as stale rows pointing at broken paths under
// `worktreesDir/{repo}/{branch}`.

describe("tRPC — plain repos (self-heal replaces stale git worktrees)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "ex-git");

    // Seed the row as if it WAS a real git repo (had `feat/foo` and
    // `fix/bar` worktrees under worktreesDir). The user has now deleted
    // `.git` outside the dashboard, so the folder is plain, but the DB
    // still records the old worktrees.
    seedState(tmpHome, {
      repos: [
        {
          name: "ex-git",
          path: plainPath,
          defaultBranch: "main",
          kind: "git",
          worktrees: [
            { branch: "main", path: plainPath },
            {
              branch: "feat/foo",
              path: join(tmpHome, ".band", "worktrees", "ex-git", "feat-foo"),
            },
            {
              branch: "fix/bar",
              path: join(tmpHome, ".band", "worktrees", "ex-git", "fix-bar"),
            },
          ],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("self-heal replaces orphaned git worktrees with the implicit main worktree", async () => {
    const res = await trpcQuery(server.url, "repos.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{
      repos: Array<{
        name: string;
        kind: "git" | "plain";
        worktrees: Array<{ branch: string; path: string }>;
      }>;
    }>(res);
    const proj = data.repos.find((p) => p.name === "ex-git")!;
    expect(proj.kind).toBe("plain");
    // The stale `feat/foo` and `fix/bar` rows are gone — only the
    // implicit "main" worktree at the repo path remains.
    expect(proj.worktrees).toHaveLength(1);
    expect(proj.worktrees[0].branch).toBe("main");
    expect(proj.worktrees[0].path).toBe(plainPath);
  });
});

// ---------------------------------------------------------------------------
// `.git` as a file (git submodule / secondary worktree)
// ---------------------------------------------------------------------------
//
// Git submodules and secondary worktrees embed a `.git` *file* (not a
// directory) that points at the parent repo. `existsSync` returns true
// for both, so they should be classified as `kind: "git"`.

describe("tRPC — plain repos (.git as file → kind: git)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let submodulePath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    // Simulate a git submodule / secondary worktree: a folder where
    // `.git` is a file containing `gitdir: ...` rather than a directory.
    submodulePath = join(tmpHome, "as-submodule");
    mkdirSync(submodulePath, { recursive: true });
    writeFileSync(join(submodulePath, ".git"), "gitdir: ../parent/.git/modules/sub\n");

    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("repos.add classifies a folder with a `.git` *file* as kind=git", async () => {
    const res = await trpcMutate(server.url, "repos.add", { path: submodulePath });
    // The git probes inside the add() path may fail because the gitdir
    // pointer is fake, but the kind classification is purely
    // existsSync-based and must still come back as "git". The
    // `defaultBranch` falls back to "main" when symbolic-ref fails,
    // which is fine.
    expect(res.status).toBe(200);
    const data = await trpcData<{ name: string; kind: "git" | "plain" }>(res);
    expect(data.name).toBe("as-submodule");
    expect(data.kind).toBe("git");
  });
});

// ---------------------------------------------------------------------------
// Worktree mutations on a plain repo should be rejected.
// ---------------------------------------------------------------------------

describe("tRPC — plain repos (worktree mutations rejected)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "scratch");

    seedState(tmpHome, {
      repos: [
        {
          name: "scratch",
          path: plainPath,
          defaultBranch: "main",
          kind: "plain",
          worktrees: [{ branch: "main", path: plainPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("worktrees.create rejects a new worktree on a plain repo", async () => {
    const res = await trpcMutate(server.url, "worktrees.create", {
      repo: "scratch",
      branch: "feature-1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git.*worktree/i);

    // The implicit worktree is still the only one, no new directory created.
    const listRes = await trpcQuery(server.url, "repos.list");
    const listData = await trpcData<{
      repos: Array<{ name: string; worktrees: Array<{ branch: string }> }>;
    }>(listRes);
    const branches = listData.repos[0].worktrees.map((w) => w.branch);
    expect(branches).toEqual(["main"]);
  });

  it("worktrees.remove rejects removing the implicit worktree", async () => {
    const res = await trpcMutate(server.url, "worktrees.remove", {
      repo: "scratch",
      name: "main",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git/i);
  });

  it("worktrees.gitPull rejects on a plain repo", async () => {
    const res = await trpcMutate(server.url, "worktrees.gitPull", {
      repo: "scratch",
      name: "main",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git/i);
  });

  it("worktrees.gitPush rejects on a plain repo", async () => {
    const res = await trpcMutate(server.url, "worktrees.gitPush", {
      repo: "scratch",
      name: "main",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git/i);
  });

  it("worktrees.setPinned rejects on a plain repo", async () => {
    // The flattened UI omits the Pin menu item, but the server also rejects
    // the call as a backstop. Without this guard, a CLI/API caller could
    // strand `pinned=true` on the implicit worktree, which used to crash
    // the repo tree because `displayRepos` filtered the row out.
    const res = await trpcMutate(server.url, "worktrees.setPinned", {
      repo: "scratch",
      name: "main",
      pinned: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git/i);
  });

  it("worktree.getChanges returns empty sections for plain repos", async () => {
    // The Changes sidepanel fetches this on mount. For plain repos we don't want
    // to surface a git error — return an empty result so the UI renders its
    // "folder is not a git repo" message instead.
    const res = await trpcQuery(server.url, "worktree.getChanges", {
      worktreeId: testWorktreeId("scratch", "main"),
    });
    expect(res.status).toBe(200);
    const data = await trpcData<Record<string, unknown>>(res);
    expect(data).toEqual({
      headBranch: "main",
      defaultBranch: "main",
      compareBranch: "main",
      mergeBase: null,
      branchStatus: "ready",
      conflicts: [],
      unstaged: [],
      staged: [],
      untracked: [],
      branch: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Defensive guard: getChanges short-circuits when .git is missing on
// disk regardless of the recorded kind.
// ---------------------------------------------------------------------------
//
// Race scenario: the user deletes `.git` from a terminal AFTER a
// `repos.list` cached a kind="git" classification. A subsequent
// `getChanges` call lands before the next list refresh self-heals
// kind. Without the existsSync belt-and-braces in the server, that call
// would invoke `git diff` against a non-git folder and surface a raw
// subprocess error in the Changes view.
describe("tRPC — plain repos (getChanges defensive .git guard)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "stale-git");

    // Stale state: row claims kind="git" with a "main" worktree at the
    // repo path, but the folder has no `.git`. This is exactly the
    // window between a terminal `rm -rf .git` and the next
    // repos.list self-heal tick.
    seedState(tmpHome, {
      repos: [
        {
          name: "stale-git",
          path: plainPath,
          defaultBranch: "main",
          kind: "git",
          worktrees: [{ branch: "main", path: plainPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("getChanges on a stale-git worktree returns empty sections (no git error)", async () => {
    // Call getChanges directly via the worktree endpoint. Without
    // the `!hasGit` short-circuit on the server, this would `execGit`
    // against a folder with no `.git` and throw — surfacing as the wall
    // of red text in the Changes view that motivated #427's hardening.
    const res = await trpcQuery(server.url, "worktree.getChanges", {
      worktreeId: testWorktreeId("stale-git", "main"),
    });
    expect(res.status).toBe(200);
    const data = await trpcData<Record<string, unknown[]>>(res);
    for (const section of ["conflicts", "unstaged", "staged", "untracked", "branch"]) {
      expect(data[section]).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Promotion: plain -> git. The escape hatch from the spec — runs git init
// in the folder and flips `kind`. The existing implicit worktree stays in
// place (its branch and worktreeId don't change).
// ---------------------------------------------------------------------------

describe("tRPC — plain repos (promote to git)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "scratch");
    seedState(tmpHome, {
      repos: [
        {
          name: "scratch",
          path: plainPath,
          defaultBranch: "main",
          kind: "plain",
          worktrees: [{ branch: "main", path: plainPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("repos.promoteToGit flips kind and creates a .git directory", async () => {
    expect(existsSync(join(plainPath, ".git"))).toBe(false);

    const res = await trpcMutate(server.url, "repos.promoteToGit", { name: "scratch" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; kind: string; defaultBranch: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.kind).toBe("git");
    expect(data.defaultBranch).toBe("main");

    // Real .git directory created on disk.
    expect(existsSync(join(plainPath, ".git"))).toBe(true);

    // repos.list now reports kind='git' and preserves the worktreeId.
    const listRes = await trpcQuery(server.url, "repos.list");
    const listData = await trpcData<{
      repos: Array<{
        name: string;
        kind: "git" | "plain";
        worktrees: Array<{ branch: string; worktreeId: string }>;
      }>;
    }>(listRes);
    const proj = listData.repos.find((p) => p.name === "scratch")!;
    expect(proj.kind).toBe("git");
    // The implicit "main" worktree stays — its path now corresponds to
    // git's main worktree, and its worktreeId is stable across promotion
    // so the user's chats/terminals/browsers keep working.
    expect(proj.worktrees.some((w) => w.worktreeId === testWorktreeId("scratch", "main"))).toBe(
      true,
    );
  });

  it("repos.promoteToGit on an already-git repo returns 400", async () => {
    const res = await trpcMutate(server.url, "repos.promoteToGit", { name: "scratch" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already a git repo/i);
  });

  it("repos.promoteToGit on a missing repo returns 404", async () => {
    const res = await trpcMutate(server.url, "repos.promoteToGit", { name: "nonexistent" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/not found/i);
  });

  it("repos.promoteToGit on a repo whose folder was deleted returns 404", async () => {
    // Add a plain repo whose folder we then delete from under the
    // server (simulates the user `rm -rf`'ing the repo directory
    // outside the dashboard, then clicking Promote in a stale UI).
    // Server pre-flight `existsSync(repo.path)` must catch this
    // before invoking `execGit`, so the user gets a clear "no longer
    // exists, remove and re-add" message rather than a raw ENOENT
    // from git.
    const ghost = createPlainDir(tmpHome, "ghost");
    const addRes = await trpcMutate(server.url, "repos.add", { path: ghost });
    expect(addRes.status).toBe(200);
    rmSync(ghost, { recursive: true, force: true });

    const res = await trpcMutate(server.url, "repos.promoteToGit", { name: "ghost" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/no longer exists/i);
  });

  it("after promotion, worktree.getChanges returns real git data, not the empty stub", async () => {
    // The pre-promotion test in the plain-rejection block verifies
    // that getChanges returns an empty stub for plain repos.
    // Once promoted, the same worktreeId should get real `git status`
    // output. The freshly-promoted repo has the existing `notes.md`
    // file from createPlainDir as an untracked file.
    const res = await trpcQuery(server.url, "worktree.getChanges", {
      worktreeId: testWorktreeId("scratch", "main"),
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      untracked: Array<{ path: string; status: string }>;
      branchStatus: string;
    }>(res);
    expect(data.untracked.map((e) => [e.path, e.status])).toEqual([["notes.md", "U"]]);
    // No commits yet, so there is nothing to compare a branch against.
    expect(data.branchStatus).toBe("unborn-head");
  });

  it("after promotion, worktrees.create is no longer blocked by the plain-kind backstop", async () => {
    // We can't actually exercise `git worktree add` end-to-end here because
    // a freshly-promoted plain repo has zero commits — `git worktree add
    // -b feature-1` would fail with "fatal: not a valid object name" before
    // the repo's kind check matters. Instead, commit one file via the
    // running git binary (with explicit author/email env) so the repo has a
    // HEAD, then re-issue worktrees.create.
    git(plainPath, ["add", "."]);
    git(plainPath, ["commit", "-m", "initial after promotion"]);

    const res = await trpcMutate(server.url, "worktrees.create", {
      repo: "scratch",
      branch: "feature-1",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; path: string }>(res);
    expect(data.ok).toBe(true);
    // The new worktree is a real git worktree (under worktreesDir), not the
    // repo path — proving the repo really is git-backed now.
    expect(data.path).not.toBe(plainPath);
    expect(data.path).toContain("feature-1");
  });
});

// ---------------------------------------------------------------------------
// Background process tests: `branch-status-poller` and `sync-state` skip
// plain repos, and `syncWorktrees` persists the kind self-heal.
// ---------------------------------------------------------------------------
//
// `repos.list` does an *inline, in-memory* re-detection of kind so the
// dashboard response always reflects on-disk reality. Persistence of the
// flip is the job of `syncWorktrees`, which runs as the first beat of
// every `startBranchStatusPoller` tick (and at server boot before the
// interval kicks in). These tests verify the persistence side
// independently of the in-memory path by reading the SQLite DB directly
// after the server has had a chance to tick once.

describe("tRPC — plain repos (syncWorktrees self-heal persistence)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "needs-heal");

    // Stale row from the migration: kind="git" but the folder has no
    // `.git`. The first poller tick should flip it to "plain" and write
    // that change to disk via saveState.
    seedState(tmpHome, {
      repos: [
        {
          name: "needs-heal",
          path: plainPath,
          defaultBranch: "main",
          kind: "git",
          worktrees: [],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
    // `runFirstTimeSetup` (which awaits `syncWorktrees` →
    // `saveState`) runs in Phase B (after `listen()`) via
    // `setImmediate` — that's intentional, see issue #477 — so the
    // "listening" log line `startServer` blocks on can be observed
    // before the kind heal has flushed to SQLite. The per-test
    // assertion polls until the heal lands.
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("syncWorktrees persists kind=plain to disk at boot", async () => {
    // Read directly from the SQLite DB rather than via repos.list
    // (which has its own inline re-detection that would mask a
    // persistence failure). Poll until the Phase-B heal has run, with
    // a bounded retry budget so a real regression still fails the
    // test instead of hanging.
    let kind: string | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      kind = readRepoKind(server.home, "needs-heal");
      if (kind === "plain") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Throw with a descriptive message on timeout so a Phase-B
    // regression surfaces as "syncWorktrees never ran" instead of a
    // generic `expected "git" to be "plain"` assertion diff.
    if (kind !== "plain") {
      throw new Error(
        `Phase-B syncWorktrees (via runFirstTimeSetup) did not heal 'needs-heal' ` +
          `to kind=plain within 10 s (observed kind: ${String(kind)}). Regression?`,
      );
    }
    expect(kind).toBe("plain");
  });
});

describe("tRPC — plain repos (branch-status-poller skips)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "scratch");
    seedState(tmpHome, {
      repos: [
        {
          name: "scratch",
          path: plainPath,
          defaultBranch: "main",
          kind: "plain",
          worktrees: [{ branch: "main", path: plainPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("no branch_statuses row is created for a plain repo's implicit worktree", () => {
    // The poller iterates `state.repos`, skips `kind === "plain"`,
    // and emits one branch-status row per surviving worktree. Plain
    // repos must not produce one — verify by counting rows in the
    // branch_statuses table for the implicit worktreeId.
    const rows = countBranchStatusRows(server.home, testWorktreeId("scratch", "main"));
    expect(rows).toBe(0);
  });
});

describe("tRPC — plain repos (sync-state worktree reconcile skips)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "scratch");
    // Seed a plain repo with a `pinned: true` flag on its implicit
    // worktree. (Pinning is server-rejected for new plain repos,
    // but we're simulating a row that landed there via legacy state —
    // a regression in syncWorktrees that ran `listWorktrees` against
    // a plain folder would either throw, wipe the worktrees array, or
    // strip pin metadata. The skip keeps it intact.)
    seedState(tmpHome, {
      repos: [
        {
          name: "scratch",
          path: plainPath,
          defaultBranch: "main",
          kind: "plain",
          worktrees: [{ branch: "main", path: plainPath, pinned: true }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("syncWorktrees doesn't mutate a plain repo's worktree rows", async () => {
    const res = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{
      repos: Array<{
        name: string;
        worktrees: Array<{ branch: string; path: string; pinned: boolean }>;
      }>;
    }>(res);
    const proj = data.repos.find((p) => p.name === "scratch")!;
    expect(proj.worktrees).toHaveLength(1);
    expect(proj.worktrees[0].branch).toBe("main");
    expect(proj.worktrees[0].path).toBe(plainPath);
    // Pin metadata survived — meaning syncWorktrees didn't fall through
    // to the `gitWorktrees` enrichment branch (which would have
    // rebuilt the array from `git worktree list` output and lost the
    // pinned flag).
    expect(proj.worktrees[0].pinned).toBe(true);
  });
});
