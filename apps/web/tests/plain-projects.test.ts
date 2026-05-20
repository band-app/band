// Black-box integration tests for plain (non-git) projects (#427).
//
// The web server is spawned the same way as in `trpc.test.ts` — real
// SQLite under a tmpdir HOME, real HTTP, real filesystem. No mocks. Each
// describe block gets its own server so the test cases stay independent.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countBranchStatusRows,
  readProjectKind,
  seedSettings,
  seedState,
} from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "plain-projects-token";

// ---------------------------------------------------------------------------
// Local copies of the helpers from trpc.test.ts — duplicated rather than
// extracted to keep test files self-contained (per repo convention; the
// existing test files each carry their own copies too).
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-plain-test-")));
  mkdirSync(join(tmp, ".band"), { recursive: true });
  return tmp;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(opts: { tmpHome: string }): Promise<ServerHandle> {
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: opts.tmpHome,
        PORT: String(port),
        NODE_ENV: "production",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home: opts.tmpHome,
          close: () =>
            new Promise<void>((r) => {
              child.on("exit", () => r());
              child.kill("SIGTERM");
            }),
        });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited with code ${code} before listening.\nstderr: ${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Server did not start within 15 s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
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
// Adding plain projects
// ---------------------------------------------------------------------------

describe("tRPC — plain projects (add)", () => {
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

    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("projects.add registers a plain folder with kind='plain'", async () => {
    const res = await trpcMutate(server.url, "projects.add", { path: plainPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      name: string;
      path: string;
      kind: "git" | "plain";
      worktrees: Array<{ branch: string; path: string }>;
    }>(res);
    expect(data.name).toBe("scratch");
    expect(data.kind).toBe("plain");
    // Plain projects get a single implicit workspace whose path equals
    // the project path — no worktrees directory, no clone, no copy.
    expect(data.worktrees).toHaveLength(1);
    expect(data.worktrees[0].branch).toBe("main");
    expect(data.worktrees[0].path).toBe(plainPath);
  });

  it("projects.add registers a git repo with kind='git'", async () => {
    const res = await trpcMutate(server.url, "projects.add", { path: gitRepoPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ name: string; kind: "git" | "plain" }>(res);
    expect(data.name).toBe("real-repo");
    expect(data.kind).toBe("git");
  });

  it("projects.list returns the kind field for each project", async () => {
    const res = await trpcQuery(server.url, "projects.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{
      projects: Array<{ name: string; kind?: "git" | "plain" }>;
    }>(res);
    const scratch = data.projects.find((p) => p.name === "scratch");
    const realRepo = data.projects.find((p) => p.name === "real-repo");
    expect(scratch?.kind).toBe("plain");
    expect(realRepo?.kind).toBe("git");
  });

  it("projects.list returns the implicit workspace for plain projects", async () => {
    const res = await trpcQuery(server.url, "projects.list");
    const data = await trpcData<{
      projects: Array<{
        name: string;
        worktrees: Array<{ branch: string; path: string; workspaceId: string }>;
      }>;
    }>(res);
    const scratch = data.projects.find((p) => p.name === "scratch")!;
    expect(scratch.worktrees).toHaveLength(1);
    expect(scratch.worktrees[0].branch).toBe("main");
    expect(scratch.worktrees[0].path).toBe(plainPath);
    expect(scratch.worktrees[0].workspaceId).toBe("scratch-main");
  });
});

// ---------------------------------------------------------------------------
// projects.list self-heals `kind` from the filesystem
// ---------------------------------------------------------------------------
//
// The schema migration for #427 set `DEFAULT 'git'` for every pre-existing
// row, so a project added before this PR shipped — and sitting in a plain
// folder — would otherwise stay incorrectly tagged. `projects.list` must
// re-detect kind from the on-disk state and persist the correction.

describe("tRPC — plain projects (self-heal kind)", () => {
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
      projects: [
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("re-detects kind=plain when the folder has no .git", async () => {
    const res = await trpcQuery(server.url, "projects.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{
      projects: Array<{
        name: string;
        kind: "git" | "plain";
        worktrees: Array<{ branch: string; path: string }>;
      }>;
    }>(res);
    const scratch = data.projects.find((p) => p.name === "scratch")!;
    expect(scratch.kind).toBe("plain");
    // Self-heal also synthesizes the implicit workspace that pre-PR rows
    // would have lacked, so the flattened plain UI has something to render.
    expect(scratch.worktrees).toHaveLength(1);
    expect(scratch.worktrees[0].branch).toBe("main");
    expect(scratch.worktrees[0].path).toBe(plainPath);
  });

  it("workspace mutations on the self-healed project are now plain-gated", async () => {
    // Confirm the heal persisted: a workspace mutation that checks
    // `project.kind === "plain"` must now reject (it wouldn't have before
    // the heal, because the stored kind was "git").
    const res = await trpcMutate(server.url, "workspaces.create", {
      project: "scratch",
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
// A user `rm -rf .git`-ing a real git project: the self-heal must replace
// the (now-orphaned) git-style worktrees with the implicit `main` workspace,
// not just leave them as stale rows pointing at broken paths under
// `worktreesDir/{project}/{branch}`.

describe("tRPC — plain projects (self-heal replaces stale git worktrees)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "ex-git");

    // Seed the row as if it WAS a real git project (had `feat/foo` and
    // `fix/bar` worktrees under worktreesDir). The user has now deleted
    // `.git` outside the dashboard, so the folder is plain, but the DB
    // still records the old worktrees.
    seedState(tmpHome, {
      projects: [
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("self-heal replaces orphaned git worktrees with the implicit main workspace", async () => {
    const res = await trpcQuery(server.url, "projects.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{
      projects: Array<{
        name: string;
        kind: "git" | "plain";
        worktrees: Array<{ branch: string; path: string }>;
      }>;
    }>(res);
    const proj = data.projects.find((p) => p.name === "ex-git")!;
    expect(proj.kind).toBe("plain");
    // The stale `feat/foo` and `fix/bar` rows are gone — only the
    // implicit "main" workspace at the project path remains.
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

describe("tRPC — plain projects (.git as file → kind: git)", () => {
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

    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("projects.add classifies a folder with a `.git` *file* as kind=git", async () => {
    const res = await trpcMutate(server.url, "projects.add", { path: submodulePath });
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
// Workspace mutations on a plain project should be rejected.
// ---------------------------------------------------------------------------

describe("tRPC — plain projects (workspace mutations rejected)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "scratch");

    seedState(tmpHome, {
      projects: [
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("workspaces.create rejects a new workspace on a plain project", async () => {
    const res = await trpcMutate(server.url, "workspaces.create", {
      project: "scratch",
      branch: "feature-1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git.*workspace/i);

    // The implicit workspace is still the only one, no new directory created.
    const listRes = await trpcQuery(server.url, "projects.list");
    const listData = await trpcData<{
      projects: Array<{ name: string; worktrees: Array<{ branch: string }> }>;
    }>(listRes);
    const branches = listData.projects[0].worktrees.map((w) => w.branch);
    expect(branches).toEqual(["main"]);
  });

  it("workspaces.remove rejects removing the implicit workspace", async () => {
    const res = await trpcMutate(server.url, "workspaces.remove", {
      project: "scratch",
      branch: "main",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git/i);
  });

  it("workspaces.gitPull rejects on a plain project", async () => {
    const res = await trpcMutate(server.url, "workspaces.gitPull", {
      project: "scratch",
      branch: "main",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git/i);
  });

  it("workspaces.gitPush rejects on a plain project", async () => {
    const res = await trpcMutate(server.url, "workspaces.gitPush", {
      project: "scratch",
      branch: "main",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git/i);
  });

  it("workspaces.setPinned rejects on a plain project", async () => {
    // The flattened UI omits the Pin menu item, but the server also rejects
    // the call as a backstop. Without this guard, a CLI/API caller could
    // strand `pinned=true` on the implicit worktree, which used to crash
    // the project tree because `displayProjects` filtered the row out.
    const res = await trpcMutate(server.url, "workspaces.setPinned", {
      project: "scratch",
      branch: "main",
      pinned: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/plain.*non-git/i);
  });

  it("workspace.getDiffSummary returns an empty summary for plain projects", async () => {
    // The DiffView fetches this on mount. For plain projects we don't want
    // to surface a git error — return an empty result so the UI renders its
    // "folder is not a git repo" message instead.
    const res = await trpcQuery(server.url, "workspace.getDiffSummary", {
      workspaceId: "scratch-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      stats: { filesChanged: number; insertions: number; deletions: number };
      fileStatuses: Record<string, string>;
      defaultBranch: string;
    }>(res);
    expect(data.stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
    expect(data.fileStatuses).toEqual({});
    expect(data.defaultBranch).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// Defensive guard: getDiffSummary short-circuits when .git is missing on
// disk regardless of the recorded kind.
// ---------------------------------------------------------------------------
//
// Race scenario: the user deletes `.git` from a terminal AFTER a
// `projects.list` cached a kind="git" classification. A subsequent
// `getDiffSummary` call lands before the next list refresh self-heals
// kind. Without the existsSync belt-and-braces in the server, that call
// would invoke `git diff` against a non-git folder and surface a raw
// subprocess error in the Changes view.
describe("tRPC — plain projects (getDiffSummary defensive .git guard)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "stale-git");

    // Stale state: row claims kind="git" with a "main" worktree at the
    // project path, but the folder has no `.git`. This is exactly the
    // window between a terminal `rm -rf .git` and the next
    // projects.list self-heal tick.
    seedState(tmpHome, {
      projects: [
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("getDiffSummary on a stale-git workspace returns empty stats (no git error)", async () => {
    // Call getDiffSummary directly via the workspace endpoint. Without
    // the `!hasGit` short-circuit on the server, this would `execGit`
    // against a folder with no `.git` and throw — surfacing as the wall
    // of red text in the Changes view that motivated #427's hardening.
    const res = await trpcQuery(server.url, "workspace.getDiffSummary", {
      workspaceId: "stale-git-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      stats: { filesChanged: number; insertions: number; deletions: number };
      fileStatuses: Record<string, string>;
    }>(res);
    expect(data.stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
    expect(data.fileStatuses).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Promotion: plain -> git. The escape hatch from the spec — runs git init
// in the folder and flips `kind`. The existing implicit workspace stays in
// place (its branch and workspaceId don't change).
// ---------------------------------------------------------------------------

describe("tRPC — plain projects (promote to git)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "scratch");
    seedState(tmpHome, {
      projects: [
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("projects.promoteToGit flips kind and creates a .git directory", async () => {
    expect(existsSync(join(plainPath, ".git"))).toBe(false);

    const res = await trpcMutate(server.url, "projects.promoteToGit", { name: "scratch" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; kind: string; defaultBranch: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.kind).toBe("git");
    expect(data.defaultBranch).toBe("main");

    // Real .git directory created on disk.
    expect(existsSync(join(plainPath, ".git"))).toBe(true);

    // projects.list now reports kind='git' and preserves the workspaceId.
    const listRes = await trpcQuery(server.url, "projects.list");
    const listData = await trpcData<{
      projects: Array<{
        name: string;
        kind: "git" | "plain";
        worktrees: Array<{ branch: string; workspaceId: string }>;
      }>;
    }>(listRes);
    const proj = listData.projects.find((p) => p.name === "scratch")!;
    expect(proj.kind).toBe("git");
    // The implicit "main" workspace stays — its path now corresponds to
    // git's main worktree, and its workspaceId is stable across promotion
    // so the user's chats/terminals/browsers keep working.
    expect(proj.worktrees.some((w) => w.workspaceId === "scratch-main")).toBe(true);
  });

  it("projects.promoteToGit on an already-git project returns 400", async () => {
    const res = await trpcMutate(server.url, "projects.promoteToGit", { name: "scratch" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already a git project/i);
  });

  it("projects.promoteToGit on a missing project returns 404", async () => {
    const res = await trpcMutate(server.url, "projects.promoteToGit", { name: "nonexistent" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/not found/i);
  });

  it("after promotion, workspaces.create is no longer blocked by the plain-kind backstop", async () => {
    // We can't actually exercise `git worktree add` end-to-end here because
    // a freshly-promoted plain project has zero commits — `git worktree add
    // -b feature-1` would fail with "fatal: not a valid object name" before
    // the project's kind check matters. Instead, commit one file via the
    // running git binary (with explicit author/email env) so the repo has a
    // HEAD, then re-issue workspaces.create.
    git(plainPath, ["add", "."]);
    git(plainPath, ["commit", "-m", "initial after promotion"]);

    const res = await trpcMutate(server.url, "workspaces.create", {
      project: "scratch",
      branch: "feature-1",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; path: string }>(res);
    expect(data.ok).toBe(true);
    // The new workspace is a real git worktree (under worktreesDir), not the
    // project path — proving the project really is git-backed now.
    expect(data.path).not.toBe(plainPath);
    expect(data.path).toContain("feature-1");
  });
});

// ---------------------------------------------------------------------------
// Background process tests: `branch-status-poller` and `sync-state` skip
// plain projects, and `syncWorktrees` persists the kind self-heal.
// ---------------------------------------------------------------------------
//
// `projects.list` does an *inline, in-memory* re-detection of kind so the
// dashboard response always reflects on-disk reality. Persistence of the
// flip is the job of `syncWorktrees`, which runs as the first beat of
// every `startBranchStatusPoller` tick (and at server boot before the
// interval kicks in). These tests verify the persistence side
// independently of the in-memory path by reading the SQLite DB directly
// after the server has had a chance to tick once.

describe("tRPC — plain projects (syncWorktrees self-heal persistence)", () => {
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
      projects: [
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
    // `saveState`) is awaited inside `start-server.ts` BEFORE the
    // "listening" log line that `startServer` blocks on, so by the
    // time this promise resolves the kind heal has already flushed
    // to SQLite — no setTimeout race needed.
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("syncWorktrees persists kind=plain to disk at boot", () => {
    // Read directly from the SQLite DB rather than via projects.list
    // (which has its own inline re-detection that would mask a
    // persistence failure).
    const kind = readProjectKind(server.home, "needs-heal");
    expect(kind).toBe("plain");
  });
});

describe("tRPC — plain projects (branch-status-poller skips)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "scratch");
    seedState(tmpHome, {
      projects: [
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("no branch_statuses row is created for a plain project's implicit workspace", () => {
    // The poller iterates `state.projects`, skips `kind === "plain"`,
    // and emits one branch-status row per surviving workspace. Plain
    // projects must not produce one — verify by counting rows in the
    // branch_statuses table for the implicit workspaceId.
    const rows = countBranchStatusRows(server.home, "scratch-main");
    expect(rows).toBe(0);
  });
});

describe("tRPC — plain projects (sync-state worktree reconcile skips)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    plainPath = createPlainDir(tmpHome, "scratch");
    // Seed a plain project with a `pinned: true` flag on its implicit
    // workspace. (Pinning is server-rejected for new plain projects,
    // but we're simulating a row that landed there via legacy state —
    // a regression in syncWorktrees that ran `listWorktrees` against
    // a plain folder would either throw, wipe the worktrees array, or
    // strip pin metadata. The skip keeps it intact.)
    seedState(tmpHome, {
      projects: [
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("syncWorktrees doesn't mutate a plain project's worktree rows", async () => {
    const res = await trpcQuery(server.url, "projects.list");
    const data = await trpcData<{
      projects: Array<{
        name: string;
        worktrees: Array<{ branch: string; path: string; pinned: boolean }>;
      }>;
    }>(res);
    const proj = data.projects.find((p) => p.name === "scratch")!;
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
