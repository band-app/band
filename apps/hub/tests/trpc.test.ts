import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome as createTmpHomeBase,
  type ServerHandle,
  startServer as startServerBase,
} from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { removeTmpHome } from "./helpers/tmp-home";

const DEFAULT_TOKEN = "trpc-default-token";

function createTmpHome(): string {
  return createTmpHomeBase("band-trpc-test-");
}

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string>; remoteHost?: boolean } = {},
): Promise<ServerHandle> {
  return startServerBase({
    tmpHome: opts.tmpHome ?? createTmpHome(),
    env: opts.env,
    remoteHost: opts.remoteHost,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// tRPC HTTP helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

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

function createGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# Test Repo\n");
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(join(repoPath, "src", "index.ts"), 'console.log("hello");\n');
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial commit"]);
  return repoPath;
}

// ---------------------------------------------------------------------------
// Repos CRUD
// ---------------------------------------------------------------------------

describe("tRPC — repos CRUD", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;
  let secondRepoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoPath = createGitRepo(tmpHome, "myrepo");
    secondRepoPath = createGitRepo(tmpHome, "second-repo");
    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      labels: [
        { id: "lbl_work", name: "Work", color: "#3b82f6" },
        { id: "lbl_personal", name: "Personal", color: "#8b5cf6" },
      ],
    });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("repos.list returns empty list initially", async () => {
    const res = await trpcQuery(server.url, "repos.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{ repos: unknown[]; labels: unknown[] }>(res);
    expect(data.repos).toEqual([]);
    expect(data.labels).toHaveLength(2);
  });

  it("repos.add registers a new repo", async () => {
    const res = await trpcMutate(server.url, "repos.add", { path: repoPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ name: string; path: string; defaultBranch: string }>(res);
    expect(data.name).toBe("myrepo");
    expect(data.path).toBe(repoPath);
    expect(data.defaultBranch).toBe("main");
  });

  it("repos.add rejects duplicate repo names", async () => {
    const res = await trpcMutate(server.url, "repos.add", { path: repoPath });
    expect(res.status).toBe(500);
  });

  it("repos.add rejects a non-existing label", async () => {
    const res = await trpcMutate(server.url, "repos.add", {
      path: secondRepoPath,
      label: "nonexistent",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("does not exist");
  });

  it("repos.add registers a second repo with a valid label", async () => {
    const res = await trpcMutate(server.url, "repos.add", {
      path: secondRepoPath,
      label: "lbl_work",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ name: string; label?: string }>(res);
    expect(data.name).toBe("second-repo");
    expect(data.label).toBe("lbl_work");
  });

  it("repos.list returns both repos", async () => {
    const res = await trpcQuery(server.url, "repos.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{ repos: Array<{ name: string }> }>(res);
    expect(data.repos).toHaveLength(2);
    expect(data.repos[0].name).toBe("myrepo");
    expect(data.repos[1].name).toBe("second-repo");
  });

  it("repos.list returns worktrees with worktreeId and agent status", async () => {
    const res = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{
      repos: Array<{
        name: string;
        worktrees: Array<{ branch: string; worktreeId: string; agent: unknown }>;
      }>;
    }>(res);
    const proj = data.repos.find((p) => p.name === "myrepo")!;
    expect(proj.worktrees.length).toBeGreaterThanOrEqual(1);
    const mainWt = proj.worktrees.find((wt) => wt.branch === "main")!;
    expect(mainWt.worktreeId).toBe(testWorktreeId("myrepo", "main", false));
    expect(mainWt.agent).toBeNull();
  });

  it("repos.updateLabel sets a label on a repo", async () => {
    const res = await trpcMutate(server.url, "repos.updateLabel", {
      name: "myrepo",
      label: "Personal",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{ repos: Array<{ name: string; label?: string }> }>(listRes);
    const proj = data.repos.find((p) => p.name === "myrepo")!;
    expect(proj.label).toBe("Personal");
  });

  it("repos.updateLabel clears a label when set to null", async () => {
    const res = await trpcMutate(server.url, "repos.updateLabel", {
      name: "myrepo",
      label: null,
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{ repos: Array<{ name: string; label?: string }> }>(listRes);
    const proj = data.repos.find((p) => p.name === "myrepo")!;
    expect(proj.label).toBeUndefined();
  });

  it("repos.updateLabel returns error for unknown repo", async () => {
    const res = await trpcMutate(server.url, "repos.updateLabel", {
      name: "nonexistent",
      label: "Foo",
    });
    expect(res.status).toBe(500);
  });

  it("repos.reorder changes repo order", async () => {
    const res = await trpcMutate(server.url, "repos.reorder", {
      names: ["second-repo", "myrepo"],
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{ repos: Array<{ name: string }> }>(listRes);
    expect(data.repos[0].name).toBe("second-repo");
    expect(data.repos[1].name).toBe("myrepo");
  });

  it("repos.remove deletes a repo", async () => {
    const res = await trpcMutate(server.url, "repos.remove", { name: "second-repo" });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{ repos: Array<{ name: string }> }>(listRes);
    expect(data.repos).toHaveLength(1);
    expect(data.repos[0].name).toBe("myrepo");
  });
});

// ---------------------------------------------------------------------------
// Git init repo validation
// ---------------------------------------------------------------------------

describe("tRPC — git init repo validation", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainDirPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Create a plain directory (not a git repo)
    plainDirPath = join(tmpHome, "plain-dir");
    mkdirSync(plainDirPath, { recursive: true });

    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("repos.gitInit initializes a git repo in a plain directory", async () => {
    const res = await trpcMutate(server.url, "repos.gitInit", { path: plainDirPath });
    expect(res.status).toBe(200);
  });

  it("repos.add succeeds after gitInit on a previously plain directory", async () => {
    const res = await trpcMutate(server.url, "repos.add", { path: plainDirPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ name: string; path: string; defaultBranch: string }>(res);
    expect(data.name).toBe("plain-dir");
    expect(data.path).toBe(plainDirPath);
  });
});

// ---------------------------------------------------------------------------
// Settings CRUD
// ---------------------------------------------------------------------------

describe("tRPC — settings CRUD", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("settings.get returns defaults when only tokenSecret is seeded", async () => {
    const res = await trpcQuery(server.url, "settings.get");
    expect(res.status).toBe(200);
    const data = await trpcData<Record<string, unknown>>(res);
    expect(data.worktreesDir).toBeUndefined();
  });

  it("settings.update persists settings", async () => {
    const settings = {
      worktreesDir: "/tmp/worktrees",
      autoStartTunnel: true,
    };
    const res = await trpcMutate(server.url, "settings.update", settings);
    expect(res.status).toBe(200);

    // Verify via get
    const getRes = await trpcQuery(server.url, "settings.get");
    const data = await trpcData<Record<string, unknown>>(getRes);
    expect(data.worktreesDir).toBe("/tmp/worktrees");
    expect(data.autoStartTunnel).toBe(true);
  });

  it("settings.update merges with existing settings", async () => {
    const res = await trpcMutate(server.url, "settings.update", { worktreesDir: null });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "settings.get");
    const data = await trpcData<Record<string, unknown>>(getRes);
    expect(data.worktreesDir).toBeNull();
    // Previous keys are preserved (merge semantics, not replace)
    expect(data.autoStartTunnel).toBe(true);
  });

  it("settings.update persists translucentSidebar to settings.json", async () => {
    const res = await trpcMutate(server.url, "settings.update", { translucentSidebar: false });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "settings.get");
    const data = await trpcData<Record<string, unknown>>(getRes);
    expect(data.translucentSidebar).toBe(false);
    const onDisk = JSON.parse(readFileSync(join(tmpHome, ".band", "settings.json"), "utf-8"));
    expect(onDisk.translucentSidebar).toBe(false);
  });

  it("settings.update rejects a non-boolean translucentSidebar", async () => {
    const seed = await trpcMutate(server.url, "settings.update", { translucentSidebar: false });
    expect(seed.status).toBe(200);

    const res = await trpcMutate(server.url, "settings.update", { translucentSidebar: "yes" });
    expect(res.status).toBe(400);

    const getRes = await trpcQuery(server.url, "settings.get");
    const data = await trpcData<Record<string, unknown>>(getRes);
    expect(data.translucentSidebar).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Settings written by an older build
// ---------------------------------------------------------------------------

// `maxCachedWorktrees` was a user setting until every visited worktree
// started staying mounted. A settings.json written by an older build still
// carries the key, and an older client may still send it; neither may break
// loading or saving settings.
describe("tRPC — settings with the retired maxCachedWorktrees key", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN, maxCachedWorktrees: 1, enableLSP: true });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("settings.get still requires auth", async () => {
    const res = await fetch(`${server.url}/trpc/settings.get`);
    expect(res.status).toBe(401);
  });

  it("settings.get loads a settings file that still stores the key", async () => {
    const res = await trpcQuery(server.url, "settings.get");
    expect(res.status).toBe(200);
    const data = await trpcData<Record<string, unknown>>(res);
    expect(data.enableLSP).toBe(true);
    // Ignored, not stripped: the passthrough schema keeps the stored value.
    expect(data.maxCachedWorktrees).toBe(1);
  });

  it("settings.update accepts an update that still sends the key", async () => {
    const res = await trpcMutate(server.url, "settings.update", {
      maxCachedWorktrees: 2,
      enableLSP: false,
    });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "settings.get");
    const data = await trpcData<Record<string, unknown>>(getRes);
    expect(data.enableLSP).toBe(false);
    expect(data.maxCachedWorktrees).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Worktree create, remove, and file operations
// ---------------------------------------------------------------------------

describe("tRPC — worktree operations", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Create a git repo with some files
    repoPath = join(tmpHome, "repo");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "# My Repo\n");
    writeFileSync(join(repoPath, "src", "index.ts"), 'export const hello = "world";\n');
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial commit"]);

    seedState(tmpHome, {
      repos: [
        {
          name: "repo",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
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

  // -- worktree create / remove --

  it("worktrees.create creates a new git worktree and returns path", async () => {
    const res = await trpcMutate(server.url, "worktrees.create", {
      repo: "repo",
      branch: "feature-1",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; path: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.path).toContain("feature-1");

    // Verify worktree exists via repos.list
    const listRes = await trpcQuery(server.url, "repos.list");
    const listData = await trpcData<{
      repos: Array<{ worktrees: Array<{ branch: string }> }>;
    }>(listRes);
    const branches = listData.repos[0].worktrees.map((wt) => wt.branch);
    expect(branches).toContain("feature-1");
  });

  it("worktrees.create is idempotent for existing branch", async () => {
    const res = await trpcMutate(server.url, "worktrees.create", {
      repo: "repo",
      branch: "feature-1",
    });
    expect(res.status).toBe(200);
  });

  it("worktrees.create with base branch", async () => {
    const res = await trpcMutate(server.url, "worktrees.create", {
      repo: "repo",
      branch: "feature-2",
      base: "main",
    });
    expect(res.status).toBe(200);
  });

  it("worktrees.create with prompt dispatches task", async () => {
    const res = await trpcMutate(server.url, "worktrees.create", {
      repo: "repo",
      branch: "feature-3",
      prompt: "Fix the login bug",
    });
    expect(res.status).toBe(200);

    // The worktree should be created and tracked in state
    const listRes = await trpcQuery(server.url, "repos.list");
    const repos = await trpcData<{
      repos: Array<{ name: string; worktrees: Array<{ branch: string }> }>;
    }>(listRes);
    const repo = repos.repos.find((p) => p.name === "repo");
    expect(repo?.worktrees.some((wt) => wt.branch === "feature-3")).toBe(true);
  });

  it("worktrees.create returns error for unknown repo", async () => {
    const res = await trpcMutate(server.url, "worktrees.create", {
      repo: "nonexistent",
      branch: "test",
    });
    expect(res.status).toBe(500);
  });

  it("worktrees.remove deletes a worktree and its branch", async () => {
    const res = await trpcMutate(server.url, "worktrees.remove", {
      repo: "repo",
      name: "feature-2",
    });
    expect(res.status).toBe(200);

    // Verify it's gone
    const listRes = await trpcQuery(server.url, "repos.list");
    const listData = await trpcData<{
      repos: Array<{ worktrees: Array<{ branch: string }> }>;
    }>(listRes);
    const branches = listData.repos[0].worktrees.map((wt) => wt.branch);
    expect(branches).not.toContain("feature-2");
  });

  it("worktrees.remove returns error for unknown worktree name", async () => {
    const res = await trpcMutate(server.url, "worktrees.remove", {
      repo: "repo",
      name: "nonexistent",
    });
    expect(res.status).toBe(500);
  });

  // -- worktree.listFiles --

  it("worktree.listFiles returns directory entries", async () => {
    const res = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      entries: Array<{ name: string; type: "file" | "directory" }>;
      path: string;
    }>(res);

    expect(data.path).toBe("");
    const names = data.entries.map((e) => e.name);
    expect(names).toContain("README.md");
    expect(names).toContain("src");

    // Directories come before files
    const srcEntry = data.entries.find((e) => e.name === "src")!;
    expect(srcEntry.type).toBe("directory");
  });

  it("worktree.listFiles returns subdirectory contents", async () => {
    const res = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "src",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      entries: Array<{ name: string; type: string }>;
    }>(res);
    const names = data.entries.map((e) => e.name);
    expect(names).toContain("index.ts");
  });

  it("worktree.listFiles returns error for unknown worktree", async () => {
    const res = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("nonexistent", "main"),
      path: "",
    });
    expect(res.status).toBe(500);
  });

  // -- worktree.getFile --

  it("worktree.getFile returns file content with language", async () => {
    const res = await trpcQuery(server.url, "worktree.getFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "src/index.ts",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ content: string; size: number; language?: string }>(res);
    expect(data.content).toContain('export const hello = "world"');
    expect(data.language).toBe("typescript");
    expect(data.size).toBeGreaterThan(0);
  });

  it("worktree.getFile returns markdown language for .md files", async () => {
    const res = await trpcQuery(server.url, "worktree.getFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "README.md",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ content: string; language?: string }>(res);
    expect(data.content).toContain("# My Repo");
    expect(data.language).toBe("markdown");
  });

  it("worktree.getFile returns error for unknown worktree", async () => {
    const res = await trpcQuery(server.url, "worktree.getFile", {
      worktreeId: testWorktreeId("nonexistent", "main"),
      path: "README.md",
    });
    expect(res.status).toBe(500);
  });

  // -- worktree.createFile --

  it("worktree.createFile creates an empty file at the root", async () => {
    const res = await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "NOTES.md",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);

    // Verify the new file appears in listFiles and is empty
    const listRes = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "",
    });
    const listData = await trpcData<{ entries: Array<{ name: string; type: string }> }>(listRes);
    const entry = listData.entries.find((e) => e.name === "NOTES.md");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("file");

    const getRes = await trpcQuery(server.url, "worktree.getFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "NOTES.md",
    });
    const getData = await trpcData<{ content: string }>(getRes);
    expect(getData.content).toBe("");
  });

  it("worktree.createFile creates a file inside a subdirectory with content", async () => {
    const res = await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "src/util.ts",
      content: "export const x = 1;\n",
    });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "worktree.getFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "src/util.ts",
    });
    const getData = await trpcData<{ content: string; language?: string }>(getRes);
    expect(getData.content).toBe("export const x = 1;\n");
    expect(getData.language).toBe("typescript");
  });

  it("worktree.createFile rejects an existing path", async () => {
    const res = await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "README.md",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already exists/);
  });

  it("worktree.createFile rejects path traversal attempts", async () => {
    const res = await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "../escape.txt",
    });
    expect(res.status).toBe(500);
  });

  it("worktree.createFile rejects when the parent directory does not exist", async () => {
    const res = await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "no-such-dir/file.txt",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Parent directory/);
  });

  it("worktree.createFile rejects empty path input", async () => {
    const res = await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "",
    });
    expect(res.status).toBe(400);
  });

  it("worktree.createFile rejects unknown worktree", async () => {
    const res = await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("nonexistent", "main"),
      path: "x.txt",
    });
    expect(res.status).toBe(500);
  });

  // -- worktree.createDirectory --

  it("worktree.createDirectory creates a directory at the root", async () => {
    const res = await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "docs",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "",
    });
    const listData = await trpcData<{ entries: Array<{ name: string; type: string }> }>(listRes);
    const entry = listData.entries.find((e) => e.name === "docs");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("directory");
  });

  it("worktree.createDirectory creates a nested directory under an existing one", async () => {
    const res = await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "docs/api",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "docs",
    });
    const listData = await trpcData<{ entries: Array<{ name: string; type: string }> }>(listRes);
    const entry = listData.entries.find((e) => e.name === "api");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("directory");
  });

  it("worktree.createDirectory rejects an existing path", async () => {
    const res = await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "src",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already exists/);
  });

  it("worktree.createDirectory rejects path traversal attempts", async () => {
    const res = await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "../escape-dir",
    });
    expect(res.status).toBe(500);
  });

  it("worktree.createDirectory rejects when the parent directory does not exist", async () => {
    const res = await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "no-such-parent/child",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Parent directory/);
  });

  it("worktree.createDirectory rejects empty path input", async () => {
    const res = await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "",
    });
    expect(res.status).toBe(400);
  });

  it("worktree.createDirectory rejects unknown worktree", async () => {
    const res = await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("nonexistent", "main"),
      path: "newdir",
    });
    expect(res.status).toBe(500);
  });

  // -- worktree.deletePath --

  it("worktree.deletePath deletes a file", async () => {
    // NOTES.md was created earlier in the createFile tests.
    const res = await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "NOTES.md",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; kind: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.kind).toBe("file");

    // Verify it's gone from the listing.
    const listRes = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "",
    });
    const listData = await trpcData<{ entries: Array<{ name: string }> }>(listRes);
    expect(listData.entries.find((e) => e.name === "NOTES.md")).toBeUndefined();
  });

  it("worktree.deletePath deletes a nested file", async () => {
    const res = await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "src/util.ts",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ kind: string }>(res);
    expect(data.kind).toBe("file");

    const listRes = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "src",
    });
    const listData = await trpcData<{ entries: Array<{ name: string }> }>(listRes);
    expect(listData.entries.find((e) => e.name === "util.ts")).toBeUndefined();
  });

  it("worktree.deletePath deletes an empty directory", async () => {
    const res = await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "docs/api",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ kind: string }>(res);
    expect(data.kind).toBe("directory");

    const listRes = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "docs",
    });
    const listData = await trpcData<{ entries: Array<{ name: string }> }>(listRes);
    expect(listData.entries.find((e) => e.name === "api")).toBeUndefined();
  });

  it("worktree.deletePath deletes a directory recursively", async () => {
    // Re-populate `docs` with a nested file so we can verify recursive removal.
    await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "docs/inner.txt",
      content: "hi",
    });

    const res = await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "docs",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ kind: string }>(res);
    expect(data.kind).toBe("directory");

    const listRes = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "",
    });
    const listData = await trpcData<{ entries: Array<{ name: string }> }>(listRes);
    expect(listData.entries.find((e) => e.name === "docs")).toBeUndefined();
  });

  it("worktree.deletePath rejects a missing path", async () => {
    const res = await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "no-such-thing.txt",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/does not exist/);
  });

  it("worktree.deletePath rejects path traversal attempts", async () => {
    const res = await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "../README.md",
    });
    expect(res.status).toBe(500);
  });

  it("worktree.deletePath refuses to delete .git internals", async () => {
    const res = await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: ".git",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/\.git/);
  });

  it("worktree.deletePath rejects empty path input", async () => {
    const res = await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "",
    });
    expect(res.status).toBe(400);
  });

  it("worktree.deletePath rejects unknown worktree", async () => {
    const res = await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("nonexistent", "main"),
      path: "README.md",
    });
    expect(res.status).toBe(500);
  });

  // -- worktree.renamePath --

  it("worktree.renamePath renames a file at the root", async () => {
    // Set up: create a file we can rename.
    await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "rename-me.txt",
      content: "rename my contents\n",
    });

    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "rename-me.txt",
      toPath: "renamed.txt",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; kind: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.kind).toBe("file");

    // Old path is gone, new path exists with the same content.
    const listRes = await trpcQuery(server.url, "worktree.listFiles", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "",
    });
    const listData = await trpcData<{ entries: Array<{ name: string }> }>(listRes);
    expect(listData.entries.find((e) => e.name === "rename-me.txt")).toBeUndefined();
    expect(listData.entries.find((e) => e.name === "renamed.txt")).toBeDefined();

    const getRes = await trpcQuery(server.url, "worktree.getFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "renamed.txt",
    });
    const getData = await trpcData<{ content: string }>(getRes);
    expect(getData.content).toBe("rename my contents\n");

    // Cleanup so later tests don't see the renamed entry.
    await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "renamed.txt",
    });
  });

  it("worktree.renamePath renames a directory along with its descendants", async () => {
    await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "rename-dir",
    });
    await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "rename-dir/inner.txt",
      content: "inside\n",
    });

    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "rename-dir",
      toPath: "renamed-dir",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ kind: string }>(res);
    expect(data.kind).toBe("directory");

    // Descendant file should now be under the new path.
    const innerRes = await trpcQuery(server.url, "worktree.getFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "renamed-dir/inner.txt",
    });
    const innerData = await trpcData<{ content: string }>(innerRes);
    expect(innerData.content).toBe("inside\n");

    // Cleanup.
    await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "renamed-dir",
    });
  });

  it("worktree.renamePath rejects identical source and destination", async () => {
    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "README.md",
      toPath: "README.md",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/same/);
  });

  it("worktree.renamePath rejects when destination already exists", async () => {
    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "README.md",
      toPath: "src",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already exists/);
  });

  it("worktree.renamePath rejects missing source", async () => {
    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "no-such-file.txt",
      toPath: "elsewhere.txt",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/does not exist/);
  });

  it("worktree.renamePath rejects when destination parent is missing", async () => {
    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "README.md",
      toPath: "no-such-dir/README.md",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Destination parent/);
  });

  it("worktree.renamePath rejects path traversal on the source", async () => {
    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "../README.md",
      toPath: "elsewhere.txt",
    });
    expect(res.status).toBe(500);
  });

  it("worktree.renamePath rejects path traversal on the destination", async () => {
    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "README.md",
      toPath: "../escape.txt",
    });
    expect(res.status).toBe(500);
  });

  it("worktree.renamePath refuses to rename .git internals", async () => {
    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: ".git",
      toPath: "git-backup",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/\.git/);
  });

  it("worktree.renamePath rejects empty source path", async () => {
    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "",
      toPath: "x.txt",
    });
    expect(res.status).toBe(400);
  });

  it("worktree.renamePath rejects empty destination path", async () => {
    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "README.md",
      toPath: "",
    });
    expect(res.status).toBe(400);
  });

  it("worktree.renamePath rejects unknown worktree", async () => {
    const res = await trpcMutate(server.url, "worktree.renamePath", {
      worktreeId: testWorktreeId("nonexistent", "main"),
      fromPath: "README.md",
      toPath: "x.md",
    });
    expect(res.status).toBe(500);
  });

  // -- worktree.copyPath --

  it("worktree.copyPath copies a file and leaves the original intact", async () => {
    const res = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "README.md",
      toPath: "README-copy.md",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; kind: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.kind).toBe("file");

    // Source still exists.
    const srcRes = await trpcQuery(server.url, "worktree.getFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "README.md",
    });
    expect(srcRes.status).toBe(200);

    // Copy has the same content.
    const dstRes = await trpcQuery(server.url, "worktree.getFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "README-copy.md",
    });
    const dstData = await trpcData<{ content: string }>(dstRes);
    expect(dstData.content).toBe("# My Repo\n");

    // Cleanup.
    await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "README-copy.md",
    });
  });

  it("worktree.copyPath copies a directory recursively", async () => {
    await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "to-copy",
    });
    await trpcMutate(server.url, "worktree.createFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "to-copy/inside.txt",
      content: "nested\n",
    });

    const res = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "to-copy",
      toPath: "copied",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ kind: string }>(res);
    expect(data.kind).toBe("directory");

    // Verify the nested file landed at the new path with its content.
    const innerRes = await trpcQuery(server.url, "worktree.getFile", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "copied/inside.txt",
    });
    const innerData = await trpcData<{ content: string }>(innerRes);
    expect(innerData.content).toBe("nested\n");

    // Cleanup both source and copy.
    await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "to-copy",
    });
    await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "copied",
    });
  });

  it("worktree.copyPath rejects copying onto an existing destination", async () => {
    const res = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "README.md",
      toPath: "src",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already exists/);
  });

  it("worktree.copyPath rejects copying a directory into its descendant", async () => {
    await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "outer",
    });
    await trpcMutate(server.url, "worktree.createDirectory", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "outer/inner",
    });

    const res = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "outer",
      toPath: "outer/inner/copy",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/into itself/);

    await trpcMutate(server.url, "worktree.deletePath", {
      worktreeId: testWorktreeId("repo", "main"),
      path: "outer",
    });
  });

  it("worktree.copyPath rejects missing source", async () => {
    const res = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "no-such-file.txt",
      toPath: "anywhere.txt",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/does not exist/);
  });

  it("worktree.copyPath rejects path traversal on the source", async () => {
    const res = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "../README.md",
      toPath: "elsewhere.txt",
    });
    expect(res.status).toBe(500);
  });

  it("worktree.copyPath rejects path traversal on the destination", async () => {
    const res = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "README.md",
      toPath: "../escape.txt",
    });
    expect(res.status).toBe(500);
  });

  it("worktree.copyPath refuses to copy .git internals", async () => {
    const res = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: ".git",
      toPath: "git-backup",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/\.git/);
  });

  it("worktree.copyPath rejects identical source and destination", async () => {
    const res = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "README.md",
      toPath: "README.md",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/same/);
  });

  it("worktree.copyPath rejects empty paths", async () => {
    const emptyFrom = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "",
      toPath: "x.txt",
    });
    expect(emptyFrom.status).toBe(400);

    const emptyTo = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("repo", "main"),
      fromPath: "README.md",
      toPath: "",
    });
    expect(emptyTo.status).toBe(400);
  });

  it("worktree.copyPath rejects unknown worktree", async () => {
    const res = await trpcMutate(server.url, "worktree.copyPath", {
      worktreeId: testWorktreeId("nonexistent", "main"),
      fromPath: "README.md",
      toPath: "x.md",
    });
    expect(res.status).toBe(500);
  });

  // -- worktree.getDiff --

  it("worktree.getDiff returns empty diff on clean branch", async () => {
    const res = await trpcQuery(server.url, "worktree.getDiff", {
      worktreeId: testWorktreeId("repo", "main"),
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      diff: string;
      stats: { filesChanged: number; insertions: number; deletions: number };
      compareBranch: string;
      defaultBranch: string;
      headBranch: string;
      fileStatuses: Record<string, string>;
    }>(res);
    expect(data.compareBranch).toBe("main");
    expect(data.defaultBranch).toBe("main");
    expect(data.headBranch).toBe("main");
  });

  it("worktree.getDiff returns diff for feature branch with changes", async () => {
    // Get the worktree path for feature-1
    const listRes = await trpcQuery(server.url, "repos.list");
    const listData = await trpcData<{
      repos: Array<{ worktrees: Array<{ branch: string; path: string }> }>;
    }>(listRes);
    const feature1 = listData.repos[0].worktrees.find((wt) => wt.branch === "feature-1");
    expect(feature1).toBeDefined();

    // Make a change in the feature branch
    writeFileSync(join(feature1!.path, "new-file.txt"), "new content\n");
    git(feature1!.path, ["add", "new-file.txt"]);
    git(feature1!.path, ["commit", "-m", "add new file"]);

    const res = await trpcQuery(server.url, "worktree.getDiff", {
      worktreeId: "repo-feature-1",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      diff: string;
      stats: { filesChanged: number; insertions: number };
      fileStatuses: Record<string, string>;
    }>(res);
    expect(data.diff).toContain("new-file.txt");
    expect(data.stats.filesChanged).toBeGreaterThanOrEqual(1);
    expect(data.stats.insertions).toBeGreaterThanOrEqual(1);
    expect(data.fileStatuses["new-file.txt"]).toBe("A");
  });

  it("worktree.getDiff returns error for unknown worktree", async () => {
    const res = await trpcQuery(server.url, "worktree.getDiff", {
      worktreeId: testWorktreeId("nonexistent", "main"),
    });
    expect(res.status).toBe(500);
  });

  // -- worktree.listBranches --

  it("worktree.listBranches returns branches with default first and current excluded", async () => {
    // feature-1 worktree should already exist from earlier tests in this describe block.
    const res = await trpcQuery(server.url, "worktree.listBranches", {
      worktreeId: "repo-feature-1",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      branches: string[];
      defaultBranch: string;
      headBranch: string;
    }>(res);

    expect(data.defaultBranch).toBe("main");
    expect(data.headBranch).toBe("feature-1");
    expect(data.branches).toContain("main");
    expect(data.branches[0]).toBe("main");
    // Current branch should not appear in the list (you don't compare against yourself).
    expect(data.branches).not.toContain("feature-1");
  });

  it("worktree.listBranches omits default when on the default branch", async () => {
    // On the default branch, comparing against `main` is a no-op, so the
    // server skips re-adding it to the list.
    const res = await trpcQuery(server.url, "worktree.listBranches", {
      worktreeId: testWorktreeId("repo", "main"),
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      branches: string[];
      defaultBranch: string;
      headBranch: string;
    }>(res);

    expect(data.defaultBranch).toBe("main");
    expect(data.headBranch).toBe("main");
    expect(data.branches).not.toContain("main");
  });

  it("worktree.listBranches searches local and remote branches server-side", async () => {
    // Remote-tracking refs written straight into the repo, as `git fetch`
    // would, plus `origin/HEAD` pointing at `origin/main`.
    const refs = [
      "refs/heads/search-local-a",
      "refs/heads/search-local-b",
      "refs/heads/domain-work",
      "refs/heads/develop",
      "refs/heads/dev-tools",
      "refs/remotes/origin/develop",
      "refs/remotes/origin/main",
      "refs/remotes/origin/search-remote",
    ];
    for (const ref of refs) git(repoPath, ["update-ref", ref, "main"]);
    git(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    try {
      const list = async (input: Record<string, unknown>) => {
        const res = await trpcQuery(server.url, "worktree.listBranches", {
          worktreeId: "repo-feature-1",
          ...input,
        });
        expect(res.status).toBe(200);
        return trpcData<{ branches: string[]; truncated: boolean }>(res);
      };

      // No query: remote branches are listed, the `origin/HEAD` pointer isn't,
      // staging-style branches lead, then the default branch, each followed
      // by its remote copy.
      const all = await list({});
      expect(all.branches.slice(0, 4)).toEqual([
        "develop",
        "origin/develop",
        "main",
        "origin/main",
      ]);
      expect(all.branches).toContain("origin/search-remote");
      expect(all.branches).not.toContain("origin/HEAD");
      expect(all.branches).not.toContain("origin");
      expect(all.truncated).toBe(false);

      // The query filters on the server, case-insensitively.
      const remote = await list({ query: "SEARCH-REM" });
      expect(remote.branches).toEqual(["origin/search-remote"]);

      // `limit` caps the result and flags the rest as truncated.
      const limited = await list({ query: "search", limit: 2 });
      expect(limited.branches).toEqual(["search-local-a", "search-local-b"]);
      expect(limited.truncated).toBe(true);

      // Exact matches (with or without the remote prefix) rank above names
      // that merely contain the query.
      const main = await list({ query: "main" });
      expect(main.branches).toEqual(["main", "origin/main", "domain-work"]);

      // Within one match quality, staging-style branches still lead.
      const dev = await list({ query: "dev" });
      expect(dev.branches).toEqual(["develop", "origin/develop", "dev-tools"]);
    } finally {
      git(repoPath, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
      for (const ref of refs) git(repoPath, ["update-ref", "-d", ref]);
    }
  });

  // -- worktree.getDiff with compareBranch --

  it("worktree.getDiff with non-default compareBranch uses merge-base of that branch", async () => {
    // Set up: create `develop` from main, add a commit on develop, switch back
    // to main, add a commit there. Then on a feature branch off main, the diff
    // against `develop` should NOT include the main-only commit (because the
    // merge-base of develop and HEAD is the original main tip).
    git(repoPath, ["branch", "develop"]);
    writeFileSync(join(repoPath, "develop-only.txt"), "develop\n");
    git(repoPath, ["add", "develop-only.txt"]);
    git(repoPath, ["commit", "-m", "develop commit"]);
    git(repoPath, ["branch", "-f", "develop", "HEAD"]);
    git(repoPath, ["reset", "--hard", "HEAD~1"]);

    // Create a fresh feature worktree off main.
    const createRes = await trpcMutate(server.url, "worktrees.create", {
      repo: "repo",
      branch: "feature-cmp",
    });
    expect(createRes.status).toBe(200);
    const createData = await trpcData<{ path: string }>(createRes);
    const featurePath = createData.path;

    // Add a commit on the feature branch.
    writeFileSync(join(featurePath, "feature-only.txt"), "feature\n");
    git(featurePath, ["add", "feature-only.txt"]);
    git(featurePath, ["commit", "-m", "feature commit"]);

    // Diff against `develop` — should include feature-only.txt and develop-only.txt.
    const developRes = await trpcQuery(server.url, "worktree.getDiff", {
      worktreeId: "repo-feature-cmp",
      diffMode: "branch",
      compareBranch: "develop",
    });
    expect(developRes.status).toBe(200);
    const developData = await trpcData<{
      compareBranch: string;
      defaultBranch: string;
      fileStatuses: Record<string, string>;
    }>(developRes);
    expect(developData.compareBranch).toBe("develop");
    expect(developData.defaultBranch).toBe("main");
    // develop has a file main doesn't have, so diffing HEAD against merge-base(develop, HEAD)
    // shows feature-only.txt as added (relative to the common ancestor).
    expect(developData.fileStatuses["feature-only.txt"]).toBe("A");

    // Diff against `main` — same merge-base in this setup, so the result matches.
    const mainRes = await trpcQuery(server.url, "worktree.getDiff", {
      worktreeId: "repo-feature-cmp",
      diffMode: "branch",
      compareBranch: "main",
    });
    expect(mainRes.status).toBe(200);
    const mainData = await trpcData<{ compareBranch: string }>(mainRes);
    expect(mainData.compareBranch).toBe("main");
  });

  it("worktree.getDiff rejects compareBranch starting with '-'", async () => {
    // Defense-in-depth against branch names that git would treat as flags
    // (e.g. `--upload-pack=`, `--exec=`).
    const res = await trpcQuery(server.url, "worktree.getDiff", {
      worktreeId: "repo-feature-cmp",
      diffMode: "branch",
      compareBranch: "--exec=bad",
    });
    expect(res.status).toBe(400);
  });

  // -- worktree.getChanges routes compareBranch into the branch section --
  //
  // Regression coverage for issue #396 ("Changes tab — out of sync"): the
  // badge and the Changes tab read the same procedure, so the compare branch
  // the user picked must reach it. The sections themselves are covered in
  // `worktree-changes.test.ts`.

  it("worktree.getChanges lists the branch's commits and not its uncommitted work", async () => {
    const listRes = await trpcQuery(server.url, "repos.list");
    const listData = await trpcData<{
      repos: Array<{ worktrees: Array<{ branch: string; path: string }> }>;
    }>(listRes);
    const featureCmp = listData.repos
      .flatMap((p) => p.worktrees)
      .find((wt) => wt.branch === "feature-cmp");
    expect(featureCmp).toBeDefined();
    writeFileSync(join(featureCmp!.path, "wip.txt"), "work in progress\n");

    try {
      const res = await trpcQuery(server.url, "worktree.getChanges", {
        worktreeId: "repo-feature-cmp",
      });
      expect(res.status).toBe(200);
      const data = await trpcData<{
        compareBranch: string;
        headBranch: string;
        branchStatus: string;
        untracked: Array<{ path: string }>;
        branch: Array<{ path: string; status: string }>;
      }>(res);
      expect(data.compareBranch).toBe("main");
      expect(data.headBranch).toBe("feature-cmp");
      expect(data.branchStatus).toBe("ready");
      expect(data.branch.map((e) => e.path)).toEqual(["feature-only.txt"]);
      expect(data.branch[0].status).toBe("A");
      expect(data.untracked.map((e) => e.path)).toEqual(["wip.txt"]);
    } finally {
      rmSync(join(featureCmp!.path, "wip.txt"), { force: true });
    }
  });

  it("worktree.getChanges echoes the compareBranch it compared against", async () => {
    const developRes = await trpcQuery(server.url, "worktree.getChanges", {
      worktreeId: "repo-feature-cmp",
      compareBranch: "develop",
    });
    expect(developRes.status).toBe(200);
    const developData = await trpcData<{ compareBranch: string; branchStatus: string }>(developRes);
    expect(developData.compareBranch).toBe("develop");
    expect(developData.branchStatus).toBe("ready");
  });

  it("worktree.getChanges rejects compareBranch starting with '-'", async () => {
    const res = await trpcQuery(server.url, "worktree.getChanges", {
      worktreeId: "repo-feature-cmp",
      compareBranch: "--exec=bad",
    });
    expect(res.status).toBe(400);
  });

  // -- worktrees.runScript --

  it("worktrees.runScript runs a .band script", async () => {
    // Create a .band script in the repo
    const bandDir = join(repoPath, ".band");
    mkdirSync(bandDir, { recursive: true });
    writeFileSync(join(bandDir, "on-create"), "#!/bin/bash\necho ok\n", { mode: 0o755 });

    const res = await trpcMutate(server.url, "worktrees.runScript", {
      path: repoPath,
      scriptType: "on-create",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);
  });

  it("worktrees.runScript returns error for missing script", async () => {
    const res = await trpcMutate(server.url, "worktrees.runScript", {
      path: repoPath,
      scriptType: "nonexistent-script",
    });
    expect(res.status).toBe(500);
  });

  // -- cleanup created worktrees --

  it("worktrees.remove cleans up feature-1", async () => {
    const res = await trpcMutate(server.url, "worktrees.remove", {
      repo: "repo",
      name: "feature-1",
    });
    expect(res.status).toBe(200);
  });

  it("worktrees.remove cleans up feature-3", async () => {
    const res = await trpcMutate(server.url, "worktrees.remove", {
      repo: "repo",
      name: "feature-3",
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Pinned worktrees
// ---------------------------------------------------------------------------

describe("tRPC — pinned worktrees", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;
  let mainWorktreePath: string;
  let featureWorktreePath: string;

  // Helper: extract a worktree's pinned flag via repos.list.
  async function readPinned(branch: string): Promise<boolean | undefined> {
    const res = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{
      repos: Array<{ name: string; worktrees: Array<{ branch: string; pinned: boolean }> }>;
    }>(res);
    return data.repos[0]?.worktrees.find((w) => w.branch === branch)?.pinned;
  }

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Create the repo + a second worktree on `feature` so we have
    // two branches to pin/unpin/test reorder against.
    repoPath = join(tmpHome, "pin-repo");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "README.md"), "# Pin repo\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial commit"]);

    mainWorktreePath = repoPath;
    featureWorktreePath = join(tmpHome, ".band", "worktrees", "pin-repo", "feature");
    mkdirSync(join(tmpHome, ".band", "worktrees", "pin-repo"), { recursive: true });
    git(repoPath, ["worktree", "add", "-b", "feature", featureWorktreePath]);

    seedState(tmpHome, {
      repos: [
        {
          name: "pin-repo",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { branch: "main", path: mainWorktreePath },
            { branch: "feature", path: featureWorktreePath },
          ],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });
    // The hub usage scanner still reads a worktree's checkout from the hub, so
    // this suite stays on the hub's own machine in remote-loopback mode.
    server = await startServer({ tmpHome, remoteHost: false });
  });

  afterAll(async () => {
    await server.close();
    try {
      git(repoPath, ["worktree", "remove", "--force", featureWorktreePath]);
    } catch {
      // best-effort — fine if the test crashed before the worktree was created,
      // or if it was already cleaned up
    }
    removeTmpHome(tmpHome);
  });

  it("repos.list returns pinned: false by default", async () => {
    expect(await readPinned("main")).toBe(false);
    expect(await readPinned("feature")).toBe(false);
  });

  it("worktrees.setPinned pins a worktree and repos.list reflects it", async () => {
    const res = await trpcMutate(server.url, "worktrees.setPinned", {
      repo: "pin-repo",
      name: "feature",
      pinned: true,
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);

    expect(await readPinned("feature")).toBe(true);
    // Pinning one worktree must not affect siblings.
    expect(await readPinned("main")).toBe(false);
  });

  it("worktrees.setPinned unpins a previously pinned worktree", async () => {
    const res = await trpcMutate(server.url, "worktrees.setPinned", {
      repo: "pin-repo",
      name: "feature",
      pinned: false,
    });
    expect(res.status).toBe(200);
    expect(await readPinned("feature")).toBe(false);
  });

  it("worktrees.setPinned returns an error for unknown repo", async () => {
    const res = await trpcMutate(server.url, "worktrees.setPinned", {
      repo: "no-such-repo",
      name: "feature",
      pinned: true,
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("not found");
  });

  it("worktrees.setPinned returns an error for unknown branch", async () => {
    const res = await trpcMutate(server.url, "worktrees.setPinned", {
      repo: "pin-repo",
      name: "no-such-branch",
      pinned: true,
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("not found");
  });

  it("pinned state survives creating a sibling worktree (saveState rewrite)", async () => {
    // Pin `feature`, then create a brand-new sibling worktree. The
    // saveState-on-create path wipes & re-inserts every worktree row, so
    // this is the regression test that the `pinned` flag round-trips
    // through `WorktreeState` correctly.
    let res = await trpcMutate(server.url, "worktrees.setPinned", {
      repo: "pin-repo",
      name: "feature",
      pinned: true,
    });
    expect(res.status).toBe(200);

    res = await trpcMutate(server.url, "worktrees.create", {
      repo: "pin-repo",
      branch: "sibling",
    });
    expect(res.status).toBe(200);

    expect(await readPinned("feature")).toBe(true);
    expect(await readPinned("sibling")).toBe(false);

    // Clean up: unpin and remove the sibling so the next test starts clean.
    await trpcMutate(server.url, "worktrees.setPinned", {
      repo: "pin-repo",
      name: "feature",
      pinned: false,
    });
    await trpcMutate(server.url, "worktrees.remove", {
      repo: "pin-repo",
      name: "sibling",
    });
  });

  it("pinned state persists across server restart", async () => {
    const res = await trpcMutate(server.url, "worktrees.setPinned", {
      repo: "pin-repo",
      name: "feature",
      pinned: true,
    });
    expect(res.status).toBe(200);

    // Restart the server with the same HOME — the on-disk SQLite is the
    // only persistence layer for pin state, so a fresh process must see
    // the same value.
    await server.close();
    server = await startServer({ tmpHome, remoteHost: false });

    expect(await readPinned("feature")).toBe(true);
    expect(await readPinned("main")).toBe(false);
  });

  it("worktrees.remove drops the pinned worktree's row", async () => {
    // Pin `feature` explicitly so this test owns its preconditions
    // and doesn't depend on prior tests in the describe block.
    let res = await trpcMutate(server.url, "worktrees.setPinned", {
      repo: "pin-repo",
      name: "feature",
      pinned: true,
    });
    expect(res.status).toBe(200);

    res = await trpcMutate(server.url, "worktrees.remove", {
      repo: "pin-repo",
      name: "feature",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{
      repos: Array<{ worktrees: Array<{ branch: string }> }>;
    }>(listRes);
    const branches = data.repos[0].worktrees.map((w) => w.branch);
    expect(branches).not.toContain("feature");
    expect(branches).toContain("main");
  });
});

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

describe("tRPC — statuses", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoPath = createGitRepo(tmpHome, "myrepo");
    seedState(tmpHome, {
      repos: [
        {
          name: "myrepo",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
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

  it("statuses.get returns null for non-existent worktree", async () => {
    const res = await trpcQuery(server.url, "statuses.get", { worktreeId: "myrepo-nonexistent" });
    expect(res.status).toBe(200);
    const data = await trpcData<null>(res);
    expect(data).toBeNull();
  });

  it("statuses.update creates a status file", async () => {
    const res = await trpcMutate(server.url, "statuses.update", {
      worktreeId: testWorktreeId("myrepo", "main"),
      agent: { status: "working", lastActivity: "1234567890" },
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);
  });

  it("statuses.get returns the status after update", async () => {
    const res = await trpcQuery(server.url, "statuses.get", {
      worktreeId: testWorktreeId("myrepo", "main"),
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      worktreeId: string;
      agent: { status: string; lastActivity: string };
    }>(res);
    expect(data.worktreeId).toBe(testWorktreeId("myrepo", "main"));
    expect(data.agent.status).toBe("working");
    expect(data.agent.lastActivity).toBe("1234567890");
  });

  it("statuses.update merges agent fields", async () => {
    const res = await trpcMutate(server.url, "statuses.update", {
      worktreeId: testWorktreeId("myrepo", "main"),
      agent: { status: "needs_attention" },
    });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "statuses.get", {
      worktreeId: testWorktreeId("myrepo", "main"),
    });
    const data = await trpcData<{
      worktreeId: string;
      agent: { status: string; lastActivity: string };
    }>(getRes);
    expect(data.agent.status).toBe("needs_attention");
    // lastActivity should be preserved from previous update
    expect(data.agent.lastActivity).toBe("1234567890");
  });

  it("statuses.resolve returns worktreeId for matching CWD", async () => {
    const res = await trpcQuery(server.url, "statuses.resolve", { cwd: repoPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ worktreeId: string | null }>(res);
    expect(data.worktreeId).toBe(testWorktreeId("myrepo", "main"));
  });

  it("statuses.resolve returns worktreeId for subdirectory CWD", async () => {
    const res = await trpcQuery(server.url, "statuses.resolve", { cwd: join(repoPath, "src") });
    expect(res.status).toBe(200);
    const data = await trpcData<{ worktreeId: string | null }>(res);
    expect(data.worktreeId).toBe(testWorktreeId("myrepo", "main"));
  });

  it("statuses.resolve returns null for unmatched CWD", async () => {
    const res = await trpcQuery(server.url, "statuses.resolve", { cwd: "/tmp/nonexistent" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ worktreeId: string | null }>(res);
    expect(data.worktreeId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// System checks (CLI, Hooks)
// ---------------------------------------------------------------------------

describe("tRPC — system checks", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("cli.check returns a valid status string", async () => {
    const res = await trpcQuery(server.url, "cli.check");
    expect(res.status).toBe(200);
    const data = await trpcData<{ status: string }>(res);
    expect(typeof data.status).toBe("string");
    expect([
      "Installed",
      "NotInstalled",
      "ConflictingBinary",
      "DirNotFound",
      "NotWritable",
    ]).toContain(data.status);
  });

  it("hooks.check returns installed and other_hooks_exist booleans", async () => {
    const res = await trpcQuery(server.url, "hooks.check");
    expect(res.status).toBe(200);
    const data = await trpcData<{ installed: boolean; other_hooks_exist: boolean }>(res);
    expect(typeof data.installed).toBe("boolean");
    expect(typeof data.other_hooks_exist).toBe("boolean");
    // setup.ts auto-installs Claude hooks during server boot, so they
    // should be present in the temp HOME by the time we query.
    expect(data.installed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// services router — activity level
// ---------------------------------------------------------------------------

describe("tRPC — services activity", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  it("services.getActivity defaults to 'active'", async () => {
    const res = await trpcQuery(server.url, "services.getActivity");
    expect(res.status).toBe(200);
    const data = await trpcData<{ activity: string }>(res);
    expect(data.activity).toBe("active");
  });

  it("services.setActivity accepts each valid level and getActivity reflects it", async () => {
    for (const activity of ["idle", "background", "active"] as const) {
      const setRes = await trpcMutate(server.url, "services.setActivity", { activity });
      expect(setRes.status).toBe(200);
      const setData = await trpcData<{ activity: string }>(setRes);
      expect(setData.activity).toBe(activity);

      const getRes = await trpcQuery(server.url, "services.getActivity");
      expect(getRes.status).toBe(200);
      const getData = await trpcData<{ activity: string }>(getRes);
      expect(getData.activity).toBe(activity);
    }
  });

  it("services.setActivity rejects an unknown activity", async () => {
    const res = await trpcMutate(server.url, "services.setActivity", { activity: "asleep" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Browser history
// ---------------------------------------------------------------------------

interface HistoryEntryShape {
  id: number;
  worktreeId: string;
  url: string;
  title: string | null;
  faviconUrl: string | null;
  lastVisitedAt: number;
  visitCount: number;
}

describe("tRPC — browser history", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  // Each test gets its own worktreeId so suites stay independent — the
  // server keeps the DB across tests (it's process-lifetime), so two
  // tests that both wrote to "wsA" would otherwise leak state.
  let wsCounter = 0;
  function freshWorktree(): string {
    wsCounter += 1;
    return `ws-history-${wsCounter}`;
  }

  it("history.record inserts a new entry for a worktree", async () => {
    const ws = freshWorktree();
    const recRes = await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://example.com/",
      title: "Example",
    });
    expect(recRes.status).toBe(200);

    const listRes = await trpcQuery(server.url, "history.list", { worktreeId: ws });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].url).toBe("https://example.com/");
    expect(data.entries[0].title).toBe("Example");
    expect(data.entries[0].visitCount).toBe(1);
  });

  it("history.record dedupes by (worktreeId, url) and bumps visit count", async () => {
    const ws = freshWorktree();
    const url = "https://example.com/dedupe";

    for (let i = 0; i < 3; i += 1) {
      const res = await trpcMutate(server.url, "history.record", { worktreeId: ws, url });
      expect(res.status).toBe(200);
      // Small sleep so `lastVisitedAt` strictly increases (clock
      // resolution can otherwise compress two writes onto the same ms).
      await new Promise((r) => setTimeout(r, 2));
    }

    const listRes = await trpcQuery(server.url, "history.list", { worktreeId: ws });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].visitCount).toBe(3);
  });

  it("history.record filters disallowed URL schemes", async () => {
    const ws = freshWorktree();

    // Each of these URLs is a Chromium-internal / extension / devtools /
    // local-file scheme that must never make it into history. The
    // mutation accepts them (status 200) but returns `recorded: false`
    // so callers can distinguish a filtered URL from one that hit the
    // DB.
    for (const url of [
      "about:blank",
      "chrome-extension://abcdef/options.html",
      "devtools://devtools/bundled/inspector.html",
      "file:///etc/hosts",
    ]) {
      const res = await trpcMutate(server.url, "history.record", { worktreeId: ws, url });
      expect(res.status).toBe(200);
      const body = await trpcData<{ recorded: boolean }>(res);
      expect(body.recorded).toBe(false);
    }

    const listRes = await trpcQuery(server.url, "history.list", { worktreeId: ws });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(data.entries).toHaveLength(0);
  });

  it("history.record rejects disallowed faviconUrl schemes", async () => {
    const ws = freshWorktree();
    // The faviconUrl is rendered as <img src> in the popover /
    // autocomplete; we restrict it to http(s) so a renderer can't
    // smuggle in `data:` URIs (DB inflation) or `javascript:`
    // (XSS hygiene).
    for (const faviconUrl of [
      "javascript:alert(1)",
      "data:image/png;base64,iVBOR=",
      "file:///etc/favicon.ico",
      "ftp://example.com/favicon.ico",
      "not-a-url",
    ]) {
      const res = await trpcMutate(server.url, "history.record", {
        worktreeId: ws,
        url: "https://example.com/scheme-check",
        faviconUrl,
      });
      // Zod refinement failure surfaces as 400.
      expect(res.status).toBe(400);
    }
    // And the http(s) cases must still succeed.
    for (const faviconUrl of [
      "https://example.com/favicon.ico",
      "http://example.com/favicon.ico",
    ]) {
      const res = await trpcMutate(server.url, "history.record", {
        worktreeId: ws,
        url: `https://example.com/scheme-ok-${encodeURIComponent(faviconUrl)}`,
        faviconUrl,
      });
      expect(res.status).toBe(200);
    }
  });

  it("history.updateMeta backfills title and favicon on an existing entry", async () => {
    const ws = freshWorktree();
    const url = "https://example.com/meta";

    await trpcMutate(server.url, "history.record", { worktreeId: ws, url });

    const res = await trpcMutate(server.url, "history.updateMeta", {
      worktreeId: ws,
      url,
      title: "Late-arriving title",
      faviconUrl: "https://example.com/favicon.ico",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "history.list", { worktreeId: ws });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(data.entries[0].title).toBe("Late-arriving title");
    expect(data.entries[0].faviconUrl).toBe("https://example.com/favicon.ico");
  });

  it("history.updateMeta is a no-op when no matching row exists", async () => {
    const ws = freshWorktree();
    const res = await trpcMutate(server.url, "history.updateMeta", {
      worktreeId: ws,
      url: "https://nothing.example/",
      title: "Phantom",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "history.list", { worktreeId: ws });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(data.entries).toHaveLength(0);
  });

  it("history.list returns entries in recency order and is worktree-scoped", async () => {
    const wsA = freshWorktree();
    const wsB = freshWorktree();

    await trpcMutate(server.url, "history.record", {
      worktreeId: wsA,
      url: "https://a.example/first",
    });
    await new Promise((r) => setTimeout(r, 2));
    await trpcMutate(server.url, "history.record", {
      worktreeId: wsA,
      url: "https://a.example/second",
    });
    await new Promise((r) => setTimeout(r, 2));
    await trpcMutate(server.url, "history.record", {
      worktreeId: wsB,
      url: "https://b.example/only",
    });

    const aRes = await trpcQuery(server.url, "history.list", { worktreeId: wsA });
    const aData = await trpcData<{ entries: HistoryEntryShape[] }>(aRes);
    expect(aData.entries.map((e) => e.url)).toEqual([
      "https://a.example/second",
      "https://a.example/first",
    ]);

    const bRes = await trpcQuery(server.url, "history.list", { worktreeId: wsB });
    const bData = await trpcData<{ entries: HistoryEntryShape[] }>(bRes);
    expect(bData.entries.map((e) => e.url)).toEqual(["https://b.example/only"]);
  });

  it("history.search matches on URL and title and ranks by frecency", async () => {
    const ws = freshWorktree();

    // High-frecency: recorded 5 times, very recent.
    for (let i = 0; i < 5; i += 1) {
      await trpcMutate(server.url, "history.record", {
        worktreeId: ws,
        url: "https://docs.example.com/frequent",
        title: "Docs frequent page",
      });
      await new Promise((r) => setTimeout(r, 2));
    }

    // Low-frecency: recorded once, equally recent.
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://docs.example.com/rare",
      title: "Other rare page",
    });

    // Title-only match — substring match on title, not URL.
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://misc.example.com/whatever",
      title: "Docs by title only",
    });

    const res = await trpcQuery(server.url, "history.search", {
      worktreeId: ws,
      query: "docs",
    });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(res);

    // All three rows should match (two on URL substring "docs.", one on
    // title "Docs by title only").
    expect(data.entries).toHaveLength(3);
    // Frecency winner is the 5-visit row, regardless of which row was
    // inserted last.
    expect(data.entries[0].url).toBe("https://docs.example.com/frequent");
  });

  it("history.search returns nothing for an empty query", async () => {
    const ws = freshWorktree();
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://example.org/",
    });
    const res = await trpcQuery(server.url, "history.search", { worktreeId: ws, query: "" });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(res);
    expect(data.entries).toEqual([]);
  });

  it("history.search treats LIKE metacharacters as literals", async () => {
    const ws = freshWorktree();
    // One row whose URL actually contains '%', two without.
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://example.com/literal%percent",
    });
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://example.com/other-a",
    });
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://example.com/other-b",
    });

    // A bare `%` without escaping would match every row (SQLite LIKE
    // wildcard). After escaping it should be treated as a literal
    // character — only the one matching URL comes back.
    const res = await trpcQuery(server.url, "history.search", {
      worktreeId: ws,
      query: "%percent",
    });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(res);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].url).toContain("%percent");

    // And `_` is also a SQLite wildcard (single character) — same
    // treatment.
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://example.com/with_underscore",
    });
    const underscoreRes = await trpcQuery(server.url, "history.search", {
      worktreeId: ws,
      query: "with_under",
    });
    const underscoreData = await trpcData<{ entries: HistoryEntryShape[] }>(underscoreRes);
    expect(underscoreData.entries).toHaveLength(1);
    expect(underscoreData.entries[0].url).toContain("with_underscore");

    // Backslash is the LIKE escape character itself — our code
    // escapes it (so a literal `\` in the input stays literal) AND
    // passes `ESCAPE '\\'` to SQLite. The end-to-end test confirms
    // the JS→SQLite escape chain isn't double-unescaped along the
    // way.
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://example.com/with\\backslash",
    });
    const slashRes = await trpcQuery(server.url, "history.search", {
      worktreeId: ws,
      query: "with\\back",
    });
    const slashData = await trpcData<{ entries: HistoryEntryShape[] }>(slashRes);
    expect(slashData.entries).toHaveLength(1);
    expect(slashData.entries[0].url).toContain("with\\backslash");
  });

  it("history.delete removes a single entry by id", async () => {
    const ws = freshWorktree();
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://a.example/keep",
    });
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://a.example/delete",
    });

    const listRes = await trpcQuery(server.url, "history.list", { worktreeId: ws });
    const listData = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    const toDelete = listData.entries.find((e) => e.url.endsWith("/delete"));
    expect(toDelete).toBeDefined();

    const delRes = await trpcMutate(server.url, "history.delete", {
      id: toDelete!.id,
      worktreeId: ws,
    });
    expect(delRes.status).toBe(200);

    const afterRes = await trpcQuery(server.url, "history.list", { worktreeId: ws });
    const afterData = await trpcData<{ entries: HistoryEntryShape[] }>(afterRes);
    expect(afterData.entries.map((e) => e.url)).toEqual(["https://a.example/keep"]);
  });

  it("history.delete is scoped to the worktree — can't delete other worktree's rows", async () => {
    const wsA = freshWorktree();
    const wsB = freshWorktree();
    await trpcMutate(server.url, "history.record", {
      worktreeId: wsA,
      url: "https://a.example/owned-by-a",
    });

    // Find the row id under worktree A.
    const listRes = await trpcQuery(server.url, "history.list", { worktreeId: wsA });
    const listData = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    const targetId = listData.entries[0].id;

    // Attempt to delete it as worktree B — should be a silent no-op.
    const delRes = await trpcMutate(server.url, "history.delete", {
      id: targetId,
      worktreeId: wsB,
    });
    expect(delRes.status).toBe(200);

    // Row still exists under wsA.
    const afterRes = await trpcQuery(server.url, "history.list", { worktreeId: wsA });
    const afterData = await trpcData<{ entries: HistoryEntryShape[] }>(afterRes);
    expect(afterData.entries).toHaveLength(1);
  });

  it("history.clear with range 'all' wipes only the target worktree", async () => {
    const wsA = freshWorktree();
    const wsB = freshWorktree();

    await trpcMutate(server.url, "history.record", {
      worktreeId: wsA,
      url: "https://a.example/x",
    });
    await trpcMutate(server.url, "history.record", {
      worktreeId: wsB,
      url: "https://b.example/y",
    });

    const clearRes = await trpcMutate(server.url, "history.clear", {
      worktreeId: wsA,
      range: "all",
    });
    expect(clearRes.status).toBe(200);
    const clearData = await trpcData<{ deleted: number }>(clearRes);
    expect(clearData.deleted).toBe(1);

    const aListRes = await trpcQuery(server.url, "history.list", { worktreeId: wsA });
    const aListData = await trpcData<{ entries: HistoryEntryShape[] }>(aListRes);
    expect(aListData.entries).toEqual([]);

    const bListRes = await trpcQuery(server.url, "history.list", { worktreeId: wsB });
    const bListData = await trpcData<{ entries: HistoryEntryShape[] }>(bListRes);
    expect(bListData.entries).toHaveLength(1);
  });

  it("history.clear with range 'hour' only deletes recent entries", async () => {
    const ws = freshWorktree();

    // Seed a fresh row (recorded now).
    await trpcMutate(server.url, "history.record", {
      worktreeId: ws,
      url: "https://example.com/recent",
    });

    const clearRes = await trpcMutate(server.url, "history.clear", {
      worktreeId: ws,
      range: "hour",
    });
    expect(clearRes.status).toBe(200);
    const clearData = await trpcData<{ deleted: number }>(clearRes);
    expect(clearData.deleted).toBe(1);

    // Verify the row is gone.
    const listRes = await trpcQuery(server.url, "history.list", { worktreeId: ws });
    const listData = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(listData.entries).toEqual([]);
  });

  // "Last day" / "Last week" semantics — these ranges delete RECENT
  // entries (visited within the window), not old ones, matching how
  // browsers' "Clear browsing history → Last hour / day / week"
  // option works. We can't test the boundary precisely from
  // integration tests (the IPC doesn't accept a `now` override), but
  // we can at least confirm a fresh row IS cleared by each range.
  for (const range of ["day", "week"] as const) {
    it(`history.clear with range '${range}' deletes recent entries`, async () => {
      const ws = freshWorktree();
      await trpcMutate(server.url, "history.record", {
        worktreeId: ws,
        url: `https://example.com/${range}-recent`,
      });

      const clearRes = await trpcMutate(server.url, "history.clear", {
        worktreeId: ws,
        range,
      });
      expect(clearRes.status).toBe(200);
      const clearData = await trpcData<{ deleted: number }>(clearRes);
      expect(clearData.deleted).toBe(1);

      const listRes = await trpcQuery(server.url, "history.list", { worktreeId: ws });
      const listData = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
      expect(listData.entries).toEqual([]);
    });
  }

  it("history.clear rejects an unknown range", async () => {
    const ws = freshWorktree();
    const res = await trpcMutate(server.url, "history.clear", {
      worktreeId: ws,
      range: "forever",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Auth enforcement on tRPC endpoints
// ---------------------------------------------------------------------------

describe("tRPC — auth enforcement", () => {
  const TOKEN = "trpc-test-token";
  let server: ServerHandle;
  let tmpHome: string;
  let authCookie: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, { repos: [] });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });

    authCookie = `band_token=${TOKEN}`;
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  // Queries
  it("returns 401 for repos.list without auth", async () => {
    const res = await trpcQuery(server.url, "repos.list");
    expect(res.status).toBe(401);
  });

  it("returns 200 for repos.list with auth", async () => {
    const res = await fetch(`${server.url}/trpc/repos.list`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for settings.get without auth", async () => {
    const res = await trpcQuery(server.url, "settings.get");
    expect(res.status).toBe(401);
  });

  it("returns 200 for settings.get with auth", async () => {
    const res = await fetch(`${server.url}/trpc/settings.get`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });

  // Mutations
  it("returns 401 for settings.update without auth", async () => {
    const res = await trpcMutate(server.url, "settings.update", { foo: "bar" });
    expect(res.status).toBe(401);
  });

  it("returns 200 for settings.update with auth", async () => {
    const res = await fetch(`${server.url}/trpc/settings.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ worktreesDir: null }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for repos.add without auth", async () => {
    const res = await trpcMutate(server.url, "repos.add", { path: "/tmp/fake" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Worktree identity is the immutable `name`, not the live git branch
// ---------------------------------------------------------------------------
//
// Black-box HTTP coverage for the crux of the `name` feature: once a
// worktree's git branch is switched away from the branch it was created on,
// the worktree id (and everything keyed by it) must stay stable and the
// repos-list label must keep showing the original `name`, while the
// reported `branch` tracks git. Complements the white-box `sync-service`
// unit test with the real server + tRPC surface (issue: worktree-name-field
// review feedback [13]).
describe("tRPC — worktree identity survives a git branch switch", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let featureWorktreePath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Real repo + a real second worktree on `feature`, whose branch we then
    // switch to `feature-renamed` — so on disk the worktree's live branch
    // diverges from the `name` it was created under.
    const repoPath = join(tmpHome, "proj");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "README.md"), "# proj\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial commit"]);

    featureWorktreePath = join(tmpHome, ".band", "worktrees", "proj", "feature");
    mkdirSync(join(tmpHome, ".band", "worktrees", "proj"), { recursive: true });
    git(repoPath, ["worktree", "add", "-b", "feature", featureWorktreePath]);
    // Switch the live branch away from the creation branch.
    git(featureWorktreePath, ["switch", "-c", "feature-renamed"]);

    // Seed the divergent state directly: identity `name: "feature"` frozen at
    // creation, live `branch: "feature-renamed"`. The seed helper supports an
    // explicit `name` distinct from `branch` for exactly this scenario.
    seedState(tmpHome, {
      repos: [
        {
          name: "proj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: repoPath },
            { name: "feature", branch: "feature-renamed", path: featureWorktreePath },
          ],
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
    try {
      git(join(tmpHome, "proj"), ["worktree", "remove", "--force", featureWorktreePath]);
    } catch {
      // best-effort — fine if already removed by the test
    }
    removeTmpHome(tmpHome);
  });

  it("repos.list keys the worktree id on `name` while reporting the live branch", async () => {
    const res = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{
      repos: Array<{
        name: string;
        worktrees: Array<{ name: string; branch: string; worktreeId: string }>;
      }>;
    }>(res);

    const proj = data.repos.find((p) => p.name === "proj");
    expect(proj).toBeDefined();

    const feature = proj!.worktrees.find((wt) => wt.name === "feature");
    expect(feature).toBeDefined();
    // Id is derived from the immutable `name`, so it stays `proj-feature`…
    expect(feature!.worktreeId).toBe(testWorktreeId("proj", "feature"));
    // …even though the live git branch has moved on.
    expect(feature!.branch).toBe("feature-renamed");
    // The id must NOT have followed the branch to `proj-feature-renamed`.
    const ids = proj!.worktrees.map((wt) => wt.worktreeId);
    expect(ids).not.toContain("proj-feature-renamed");
  });

  it("worktrees.remove resolves by `name` even when the branch was switched", async () => {
    const res = await trpcMutate(server.url, "worktrees.remove", {
      repo: "proj",
      name: "feature",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "repos.list");
    const data = await trpcData<{
      repos: Array<{ name: string; worktrees: Array<{ name: string }> }>;
    }>(listRes);
    const proj = data.repos.find((p) => p.name === "proj");
    expect(proj!.worktrees.map((wt) => wt.name)).not.toContain("feature");
  });
});
