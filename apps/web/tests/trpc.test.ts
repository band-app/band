import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "trpc-default-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-trpc-test-")));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  return tmp;
}

function seedSettings(tmpHome: string, settings: object): void {
  writeFileSync(join(tmpHome, ".band", "settings.json"), JSON.stringify(settings));
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

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/start-server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        ...opts.env,
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
          home,
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
  writeFileSync(join(repoPath, "README.md"), "# Test Project\n");
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(join(repoPath, "src", "index.ts"), 'console.log("hello");\n');
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial commit"]);
  return repoPath;
}

// ---------------------------------------------------------------------------
// Projects CRUD
// ---------------------------------------------------------------------------

describe("tRPC — projects CRUD", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;
  let secondRepoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoPath = createGitRepo(tmpHome, "myrepo");
    secondRepoPath = createGitRepo(tmpHome, "second-repo");
    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("projects.list returns empty list initially", async () => {
    const res = await trpcQuery(server.url, "projects.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{ projects: unknown[]; labels: unknown[] }>(res);
    expect(data.projects).toEqual([]);
    expect(data.labels).toEqual([]);
  });

  it("projects.add registers a new project", async () => {
    const res = await trpcMutate(server.url, "projects.add", { path: repoPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ name: string; path: string; defaultBranch: string }>(res);
    expect(data.name).toBe("myrepo");
    expect(data.path).toBe(repoPath);
    expect(data.defaultBranch).toBe("main");
  });

  it("projects.add rejects duplicate project names", async () => {
    const res = await trpcMutate(server.url, "projects.add", { path: repoPath });
    expect(res.status).toBe(500);
  });

  it("projects.add registers a second project with a label", async () => {
    const res = await trpcMutate(server.url, "projects.add", {
      path: secondRepoPath,
      label: "Work",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ name: string; label?: string }>(res);
    expect(data.name).toBe("second-repo");
    expect(data.label).toBe("Work");
  });

  it("projects.list returns both projects", async () => {
    const res = await trpcQuery(server.url, "projects.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{ projects: Array<{ name: string }> }>(res);
    expect(data.projects).toHaveLength(2);
    expect(data.projects[0].name).toBe("myrepo");
    expect(data.projects[1].name).toBe("second-repo");
  });

  it("projects.list returns worktrees with workspaceId and agent status", async () => {
    const res = await trpcQuery(server.url, "projects.list");
    const data = await trpcData<{
      projects: Array<{
        name: string;
        worktrees: Array<{ branch: string; workspaceId: string; agent: unknown }>;
      }>;
    }>(res);
    const proj = data.projects.find((p) => p.name === "myrepo")!;
    expect(proj.worktrees.length).toBeGreaterThanOrEqual(1);
    const mainWt = proj.worktrees.find((wt) => wt.branch === "main")!;
    expect(mainWt.workspaceId).toBe("myrepo-main");
    expect(mainWt.agent).toBeNull();
  });

  it("projects.updateLabel sets a label on a project", async () => {
    const res = await trpcMutate(server.url, "projects.updateLabel", {
      name: "myrepo",
      label: "Personal",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "projects.list");
    const data = await trpcData<{ projects: Array<{ name: string; label?: string }> }>(listRes);
    const proj = data.projects.find((p) => p.name === "myrepo")!;
    expect(proj.label).toBe("Personal");
  });

  it("projects.updateLabel clears a label when set to null", async () => {
    const res = await trpcMutate(server.url, "projects.updateLabel", {
      name: "myrepo",
      label: null,
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "projects.list");
    const data = await trpcData<{ projects: Array<{ name: string; label?: string }> }>(listRes);
    const proj = data.projects.find((p) => p.name === "myrepo")!;
    expect(proj.label).toBeUndefined();
  });

  it("projects.updateLabel returns error for unknown project", async () => {
    const res = await trpcMutate(server.url, "projects.updateLabel", {
      name: "nonexistent",
      label: "Foo",
    });
    expect(res.status).toBe(500);
  });

  it("projects.reorder changes project order", async () => {
    const res = await trpcMutate(server.url, "projects.reorder", {
      names: ["second-repo", "myrepo"],
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "projects.list");
    const data = await trpcData<{ projects: Array<{ name: string }> }>(listRes);
    expect(data.projects[0].name).toBe("second-repo");
    expect(data.projects[1].name).toBe("myrepo");
  });

  it("projects.remove deletes a project", async () => {
    const res = await trpcMutate(server.url, "projects.remove", { name: "second-repo" });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "projects.list");
    const data = await trpcData<{ projects: Array<{ name: string }> }>(listRes);
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].name).toBe("myrepo");
  });
});

// ---------------------------------------------------------------------------
// Git init project validation
// ---------------------------------------------------------------------------

describe("tRPC — git init project validation", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let gitRepoPath: string;
  let plainDirPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    gitRepoPath = createGitRepo(tmpHome, "existing-repo");

    // Create a plain directory (not a git repo)
    plainDirPath = join(tmpHome, "plain-dir");
    mkdirSync(plainDirPath, { recursive: true });

    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("projects.checkPath returns isGitRepo true for a git repo", async () => {
    const res = await trpcQuery(server.url, "projects.checkPath", { path: gitRepoPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ isGitRepo: boolean }>(res);
    expect(data.isGitRepo).toBe(true);
  });

  it("projects.checkPath returns isGitRepo false for a plain directory", async () => {
    const res = await trpcQuery(server.url, "projects.checkPath", { path: plainDirPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ isGitRepo: boolean }>(res);
    expect(data.isGitRepo).toBe(false);
  });

  it("projects.gitInit initializes a git repo in a plain directory", async () => {
    const res = await trpcMutate(server.url, "projects.gitInit", { path: plainDirPath });
    expect(res.status).toBe(200);
  });

  it("projects.checkPath returns isGitRepo true after gitInit", async () => {
    const res = await trpcQuery(server.url, "projects.checkPath", { path: plainDirPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ isGitRepo: boolean }>(res);
    expect(data.isGitRepo).toBe(true);
  });

  it("projects.add succeeds after gitInit on a previously plain directory", async () => {
    const res = await trpcMutate(server.url, "projects.add", { path: plainDirPath });
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
    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
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

  it("settings.update overwrites previous settings", async () => {
    const res = await trpcMutate(server.url, "settings.update", { worktreesDir: null });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "settings.get");
    const data = await trpcData<Record<string, unknown>>(getRes);
    expect(data.worktreesDir).toBeNull();
    // Previous keys should be gone since update replaces the whole file
    expect(data.autoStartTunnel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Workspace create, remove, and file operations
// ---------------------------------------------------------------------------

describe("tRPC — workspace operations", () => {
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
    writeFileSync(join(repoPath, "README.md"), "# My Project\n");
    writeFileSync(join(repoPath, "src", "index.ts"), 'export const hello = "world";\n');
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial commit"]);

    seedState(tmpHome, {
      projects: [
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // -- workspace create / remove --

  it("workspaces.create creates a new git worktree and returns path", async () => {
    const res = await trpcMutate(server.url, "workspaces.create", {
      project: "repo",
      branch: "feature-1",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; path: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.path).toContain("feature-1");

    // Verify worktree exists via projects.list
    const listRes = await trpcQuery(server.url, "projects.list");
    const listData = await trpcData<{
      projects: Array<{ worktrees: Array<{ branch: string }> }>;
    }>(listRes);
    const branches = listData.projects[0].worktrees.map((wt) => wt.branch);
    expect(branches).toContain("feature-1");
  });

  it("workspaces.create is idempotent for existing branch", async () => {
    const res = await trpcMutate(server.url, "workspaces.create", {
      project: "repo",
      branch: "feature-1",
    });
    expect(res.status).toBe(200);
  });

  it("workspaces.create with base branch", async () => {
    const res = await trpcMutate(server.url, "workspaces.create", {
      project: "repo",
      branch: "feature-2",
      base: "main",
    });
    expect(res.status).toBe(200);
  });

  it("workspaces.create with prompt dispatches task", async () => {
    const res = await trpcMutate(server.url, "workspaces.create", {
      project: "repo",
      branch: "feature-3",
      prompt: "Fix the login bug",
    });
    expect(res.status).toBe(200);

    // The workspace should be created and tracked in state
    const listRes = await trpcQuery(server.url, "projects.list");
    const projects = await trpcData<{
      projects: Array<{ name: string; worktrees: Array<{ branch: string }> }>;
    }>(listRes);
    const repo = projects.projects.find((p) => p.name === "repo");
    expect(repo?.worktrees.some((wt) => wt.branch === "feature-3")).toBe(true);
  });

  it("workspaces.create returns error for unknown project", async () => {
    const res = await trpcMutate(server.url, "workspaces.create", {
      project: "nonexistent",
      branch: "test",
    });
    expect(res.status).toBe(500);
  });

  it("workspaces.remove deletes a worktree and its branch", async () => {
    const res = await trpcMutate(server.url, "workspaces.remove", {
      project: "repo",
      branch: "feature-2",
    });
    expect(res.status).toBe(200);

    // Verify it's gone
    const listRes = await trpcQuery(server.url, "projects.list");
    const listData = await trpcData<{
      projects: Array<{ worktrees: Array<{ branch: string }> }>;
    }>(listRes);
    const branches = listData.projects[0].worktrees.map((wt) => wt.branch);
    expect(branches).not.toContain("feature-2");
  });

  it("workspaces.remove returns error for unknown branch", async () => {
    const res = await trpcMutate(server.url, "workspaces.remove", {
      project: "repo",
      branch: "nonexistent",
    });
    expect(res.status).toBe(500);
  });

  // -- workspace.listFiles --

  it("workspace.listFiles returns directory entries", async () => {
    const res = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "repo-main",
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

  it("workspace.listFiles returns subdirectory contents", async () => {
    const res = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "repo-main",
      path: "src",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      entries: Array<{ name: string; type: string }>;
    }>(res);
    const names = data.entries.map((e) => e.name);
    expect(names).toContain("index.ts");
  });

  it("workspace.listFiles returns error for unknown workspace", async () => {
    const res = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "nonexistent-main",
      path: "",
    });
    expect(res.status).toBe(500);
  });

  // -- workspace.getFile --

  it("workspace.getFile returns file content with language", async () => {
    const res = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "repo-main",
      path: "src/index.ts",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ content: string; size: number; language?: string }>(res);
    expect(data.content).toContain('export const hello = "world"');
    expect(data.language).toBe("typescript");
    expect(data.size).toBeGreaterThan(0);
  });

  it("workspace.getFile returns markdown language for .md files", async () => {
    const res = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "repo-main",
      path: "README.md",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ content: string; language?: string }>(res);
    expect(data.content).toContain("# My Project");
    expect(data.language).toBe("markdown");
  });

  it("workspace.getFile returns error for unknown workspace", async () => {
    const res = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "nonexistent-main",
      path: "README.md",
    });
    expect(res.status).toBe(500);
  });

  // -- workspace.getDiff --

  it("workspace.getDiff returns empty diff on clean branch", async () => {
    const res = await trpcQuery(server.url, "workspace.getDiff", {
      workspaceId: "repo-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      diff: string;
      stats: { filesChanged: number; insertions: number; deletions: number };
      baseBranch: string;
      headBranch: string;
      fileStatuses: Record<string, string>;
    }>(res);
    expect(data.baseBranch).toBe("main");
    expect(data.headBranch).toBe("main");
  });

  it("workspace.getDiff returns diff for feature branch with changes", async () => {
    // Get the worktree path for feature-1
    const listRes = await trpcQuery(server.url, "projects.list");
    const listData = await trpcData<{
      projects: Array<{ worktrees: Array<{ branch: string; path: string }> }>;
    }>(listRes);
    const feature1 = listData.projects[0].worktrees.find((wt) => wt.branch === "feature-1");
    expect(feature1).toBeDefined();

    // Make a change in the feature branch
    writeFileSync(join(feature1!.path, "new-file.txt"), "new content\n");
    git(feature1!.path, ["add", "new-file.txt"]);
    git(feature1!.path, ["commit", "-m", "add new file"]);

    const res = await trpcQuery(server.url, "workspace.getDiff", {
      workspaceId: "repo-feature-1",
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

  it("workspace.getDiff returns error for unknown workspace", async () => {
    const res = await trpcQuery(server.url, "workspace.getDiff", {
      workspaceId: "nonexistent-main",
    });
    expect(res.status).toBe(500);
  });

  // -- workspaces.runScript --

  it("workspaces.runScript runs a .band script", async () => {
    // Create a .band script in the repo
    const bandDir = join(repoPath, ".band");
    mkdirSync(bandDir, { recursive: true });
    writeFileSync(join(bandDir, "on-create"), "#!/bin/bash\necho ok\n", { mode: 0o755 });

    const res = await trpcMutate(server.url, "workspaces.runScript", {
      path: repoPath,
      scriptType: "on-create",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);
  });

  it("workspaces.runScript returns error for missing script", async () => {
    const res = await trpcMutate(server.url, "workspaces.runScript", {
      path: repoPath,
      scriptType: "nonexistent-script",
    });
    expect(res.status).toBe(500);
  });

  // -- cleanup created worktrees --

  it("workspaces.remove cleans up feature-1", async () => {
    const res = await trpcMutate(server.url, "workspaces.remove", {
      project: "repo",
      branch: "feature-1",
    });
    expect(res.status).toBe(200);
  });

  it("workspaces.remove cleans up feature-3", async () => {
    const res = await trpcMutate(server.url, "workspaces.remove", {
      project: "repo",
      branch: "feature-3",
    });
    expect(res.status).toBe(200);
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
      projects: [
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("statuses.get returns null for non-existent workspace", async () => {
    const res = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-nonexistent" });
    expect(res.status).toBe(200);
    const data = await trpcData<null>(res);
    expect(data).toBeNull();
  });

  it("statuses.update creates a status file", async () => {
    const res = await trpcMutate(server.url, "statuses.update", {
      workspaceId: "myrepo-main",
      agent: { status: "working", lastActivity: "1234567890" },
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);
  });

  it("statuses.get returns the status after update", async () => {
    const res = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      workspaceId: string;
      agent: { status: string; lastActivity: string };
    }>(res);
    expect(data.workspaceId).toBe("myrepo-main");
    expect(data.agent.status).toBe("working");
    expect(data.agent.lastActivity).toBe("1234567890");
  });

  it("statuses.update merges agent fields", async () => {
    const res = await trpcMutate(server.url, "statuses.update", {
      workspaceId: "myrepo-main",
      agent: { status: "needs_attention" },
    });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
    const data = await trpcData<{
      workspaceId: string;
      agent: { status: string; lastActivity: string };
    }>(getRes);
    expect(data.agent.status).toBe("needs_attention");
    // lastActivity should be preserved from previous update
    expect(data.agent.lastActivity).toBe("1234567890");
  });

  it("statuses.resolve returns workspaceId for matching CWD", async () => {
    const res = await trpcQuery(server.url, "statuses.resolve", { cwd: repoPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ workspaceId: string | null }>(res);
    expect(data.workspaceId).toBe("myrepo-main");
  });

  it("statuses.resolve returns workspaceId for subdirectory CWD", async () => {
    const res = await trpcQuery(server.url, "statuses.resolve", { cwd: join(repoPath, "src") });
    expect(res.status).toBe(200);
    const data = await trpcData<{ workspaceId: string | null }>(res);
    expect(data.workspaceId).toBe("myrepo-main");
  });

  it("statuses.resolve returns null for unmatched CWD", async () => {
    const res = await trpcQuery(server.url, "statuses.resolve", { cwd: "/tmp/nonexistent" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ workspaceId: string | null }>(res);
    expect(data.workspaceId).toBeNull();
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
    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
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
    // No claude settings in temp HOME, so hooks should not be installed
    expect(data.installed).toBe(false);
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
    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });

    authCookie = `band_token=${TOKEN}`;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // Queries
  it("returns 401 for projects.list without auth", async () => {
    const res = await trpcQuery(server.url, "projects.list");
    expect(res.status).toBe(401);
  });

  it("returns 200 for projects.list with auth", async () => {
    const res = await fetch(`${server.url}/trpc/projects.list`, {
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

  it("returns 401 for projects.add without auth", async () => {
    const res = await trpcMutate(server.url, "projects.add", { path: "/tmp/fake" });
    expect(res.status).toBe(401);
  });
});
