import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

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
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("projects.list returns empty list initially", async () => {
    const res = await trpcQuery(server.url, "projects.list");
    expect(res.status).toBe(200);
    const data = await trpcData<{ projects: unknown[]; labels: unknown[] }>(res);
    expect(data.projects).toEqual([]);
    expect(data.labels).toHaveLength(2);
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

  it("projects.add rejects a non-existing label", async () => {
    const res = await trpcMutate(server.url, "projects.add", {
      path: secondRepoPath,
      label: "nonexistent",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("does not exist");
  });

  it("projects.add registers a second project with a valid label", async () => {
    const res = await trpcMutate(server.url, "projects.add", {
      path: secondRepoPath,
      label: "lbl_work",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ name: string; label?: string }>(res);
    expect(data.name).toBe("second-repo");
    expect(data.label).toBe("lbl_work");
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

  it("settings.update merges with existing settings", async () => {
    const res = await trpcMutate(server.url, "settings.update", { worktreesDir: null });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "settings.get");
    const data = await trpcData<Record<string, unknown>>(getRes);
    expect(data.worktreesDir).toBeNull();
    // Previous keys are preserved (merge semantics, not replace)
    expect(data.autoStartTunnel).toBe(true);
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

  // -- workspace.createFile --

  it("workspace.createFile creates an empty file at the root", async () => {
    const res = await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "repo-main",
      path: "NOTES.md",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);

    // Verify the new file appears in listFiles and is empty
    const listRes = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "repo-main",
      path: "",
    });
    const listData = await trpcData<{ entries: Array<{ name: string; type: string }> }>(listRes);
    const entry = listData.entries.find((e) => e.name === "NOTES.md");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("file");

    const getRes = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "repo-main",
      path: "NOTES.md",
    });
    const getData = await trpcData<{ content: string }>(getRes);
    expect(getData.content).toBe("");
  });

  it("workspace.createFile creates a file inside a subdirectory with content", async () => {
    const res = await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "repo-main",
      path: "src/util.ts",
      content: "export const x = 1;\n",
    });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "repo-main",
      path: "src/util.ts",
    });
    const getData = await trpcData<{ content: string; language?: string }>(getRes);
    expect(getData.content).toBe("export const x = 1;\n");
    expect(getData.language).toBe("typescript");
  });

  it("workspace.createFile rejects an existing path", async () => {
    const res = await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "repo-main",
      path: "README.md",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already exists/);
  });

  it("workspace.createFile rejects path traversal attempts", async () => {
    const res = await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "repo-main",
      path: "../escape.txt",
    });
    expect(res.status).toBe(500);
  });

  it("workspace.createFile rejects when the parent directory does not exist", async () => {
    const res = await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "repo-main",
      path: "no-such-dir/file.txt",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Parent directory/);
  });

  it("workspace.createFile rejects empty path input", async () => {
    const res = await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "repo-main",
      path: "",
    });
    expect(res.status).toBe(400);
  });

  it("workspace.createFile rejects unknown workspace", async () => {
    const res = await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "nonexistent-main",
      path: "x.txt",
    });
    expect(res.status).toBe(500);
  });

  // -- workspace.createDirectory --

  it("workspace.createDirectory creates a directory at the root", async () => {
    const res = await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "repo-main",
      path: "docs",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "repo-main",
      path: "",
    });
    const listData = await trpcData<{ entries: Array<{ name: string; type: string }> }>(listRes);
    const entry = listData.entries.find((e) => e.name === "docs");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("directory");
  });

  it("workspace.createDirectory creates a nested directory under an existing one", async () => {
    const res = await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "repo-main",
      path: "docs/api",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "repo-main",
      path: "docs",
    });
    const listData = await trpcData<{ entries: Array<{ name: string; type: string }> }>(listRes);
    const entry = listData.entries.find((e) => e.name === "api");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("directory");
  });

  it("workspace.createDirectory rejects an existing path", async () => {
    const res = await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "repo-main",
      path: "src",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already exists/);
  });

  it("workspace.createDirectory rejects path traversal attempts", async () => {
    const res = await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "repo-main",
      path: "../escape-dir",
    });
    expect(res.status).toBe(500);
  });

  it("workspace.createDirectory rejects when the parent directory does not exist", async () => {
    const res = await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "repo-main",
      path: "no-such-parent/child",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Parent directory/);
  });

  it("workspace.createDirectory rejects empty path input", async () => {
    const res = await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "repo-main",
      path: "",
    });
    expect(res.status).toBe(400);
  });

  it("workspace.createDirectory rejects unknown workspace", async () => {
    const res = await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "nonexistent-main",
      path: "newdir",
    });
    expect(res.status).toBe(500);
  });

  // -- workspace.deletePath --

  it("workspace.deletePath deletes a file", async () => {
    // NOTES.md was created earlier in the createFile tests.
    const res = await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "NOTES.md",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; kind: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.kind).toBe("file");

    // Verify it's gone from the listing.
    const listRes = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "repo-main",
      path: "",
    });
    const listData = await trpcData<{ entries: Array<{ name: string }> }>(listRes);
    expect(listData.entries.find((e) => e.name === "NOTES.md")).toBeUndefined();
  });

  it("workspace.deletePath deletes a nested file", async () => {
    const res = await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "src/util.ts",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ kind: string }>(res);
    expect(data.kind).toBe("file");

    const listRes = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "repo-main",
      path: "src",
    });
    const listData = await trpcData<{ entries: Array<{ name: string }> }>(listRes);
    expect(listData.entries.find((e) => e.name === "util.ts")).toBeUndefined();
  });

  it("workspace.deletePath deletes an empty directory", async () => {
    const res = await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "docs/api",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ kind: string }>(res);
    expect(data.kind).toBe("directory");

    const listRes = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "repo-main",
      path: "docs",
    });
    const listData = await trpcData<{ entries: Array<{ name: string }> }>(listRes);
    expect(listData.entries.find((e) => e.name === "api")).toBeUndefined();
  });

  it("workspace.deletePath deletes a directory recursively", async () => {
    // Re-populate `docs` with a nested file so we can verify recursive removal.
    await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "repo-main",
      path: "docs/inner.txt",
      content: "hi",
    });

    const res = await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "docs",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ kind: string }>(res);
    expect(data.kind).toBe("directory");

    const listRes = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "repo-main",
      path: "",
    });
    const listData = await trpcData<{ entries: Array<{ name: string }> }>(listRes);
    expect(listData.entries.find((e) => e.name === "docs")).toBeUndefined();
  });

  it("workspace.deletePath rejects a missing path", async () => {
    const res = await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "no-such-thing.txt",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/does not exist/);
  });

  it("workspace.deletePath rejects path traversal attempts", async () => {
    const res = await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "../README.md",
    });
    expect(res.status).toBe(500);
  });

  it("workspace.deletePath refuses to delete .git internals", async () => {
    const res = await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: ".git",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/\.git/);
  });

  it("workspace.deletePath rejects empty path input", async () => {
    const res = await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "",
    });
    expect(res.status).toBe(400);
  });

  it("workspace.deletePath rejects unknown workspace", async () => {
    const res = await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "nonexistent-main",
      path: "README.md",
    });
    expect(res.status).toBe(500);
  });

  // -- workspace.renamePath --

  it("workspace.renamePath renames a file at the root", async () => {
    // Set up: create a file we can rename.
    await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "repo-main",
      path: "rename-me.txt",
      content: "rename my contents\n",
    });

    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: "rename-me.txt",
      toPath: "renamed.txt",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; kind: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.kind).toBe("file");

    // Old path is gone, new path exists with the same content.
    const listRes = await trpcQuery(server.url, "workspace.listFiles", {
      workspaceId: "repo-main",
      path: "",
    });
    const listData = await trpcData<{ entries: Array<{ name: string }> }>(listRes);
    expect(listData.entries.find((e) => e.name === "rename-me.txt")).toBeUndefined();
    expect(listData.entries.find((e) => e.name === "renamed.txt")).toBeDefined();

    const getRes = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "repo-main",
      path: "renamed.txt",
    });
    const getData = await trpcData<{ content: string }>(getRes);
    expect(getData.content).toBe("rename my contents\n");

    // Cleanup so later tests don't see the renamed entry.
    await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "renamed.txt",
    });
  });

  it("workspace.renamePath renames a directory along with its descendants", async () => {
    await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "repo-main",
      path: "rename-dir",
    });
    await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "repo-main",
      path: "rename-dir/inner.txt",
      content: "inside\n",
    });

    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: "rename-dir",
      toPath: "renamed-dir",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ kind: string }>(res);
    expect(data.kind).toBe("directory");

    // Descendant file should now be under the new path.
    const innerRes = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "repo-main",
      path: "renamed-dir/inner.txt",
    });
    const innerData = await trpcData<{ content: string }>(innerRes);
    expect(innerData.content).toBe("inside\n");

    // Cleanup.
    await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "renamed-dir",
    });
  });

  it("workspace.renamePath rejects identical source and destination", async () => {
    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: "README.md",
      toPath: "README.md",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/same/);
  });

  it("workspace.renamePath rejects when destination already exists", async () => {
    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: "README.md",
      toPath: "src",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already exists/);
  });

  it("workspace.renamePath rejects missing source", async () => {
    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: "no-such-file.txt",
      toPath: "elsewhere.txt",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/does not exist/);
  });

  it("workspace.renamePath rejects when destination parent is missing", async () => {
    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: "README.md",
      toPath: "no-such-dir/README.md",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Destination parent/);
  });

  it("workspace.renamePath rejects path traversal on the source", async () => {
    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: "../README.md",
      toPath: "elsewhere.txt",
    });
    expect(res.status).toBe(500);
  });

  it("workspace.renamePath rejects path traversal on the destination", async () => {
    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: "README.md",
      toPath: "../escape.txt",
    });
    expect(res.status).toBe(500);
  });

  it("workspace.renamePath refuses to rename .git internals", async () => {
    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: ".git",
      toPath: "git-backup",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/\.git/);
  });

  it("workspace.renamePath rejects empty source path", async () => {
    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: "",
      toPath: "x.txt",
    });
    expect(res.status).toBe(400);
  });

  it("workspace.renamePath rejects empty destination path", async () => {
    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "repo-main",
      fromPath: "README.md",
      toPath: "",
    });
    expect(res.status).toBe(400);
  });

  it("workspace.renamePath rejects unknown workspace", async () => {
    const res = await trpcMutate(server.url, "workspace.renamePath", {
      workspaceId: "nonexistent-main",
      fromPath: "README.md",
      toPath: "x.md",
    });
    expect(res.status).toBe(500);
  });

  // -- workspace.copyPath --

  it("workspace.copyPath copies a file and leaves the original intact", async () => {
    const res = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: "README.md",
      toPath: "README-copy.md",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; kind: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.kind).toBe("file");

    // Source still exists.
    const srcRes = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "repo-main",
      path: "README.md",
    });
    expect(srcRes.status).toBe(200);

    // Copy has the same content.
    const dstRes = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "repo-main",
      path: "README-copy.md",
    });
    const dstData = await trpcData<{ content: string }>(dstRes);
    expect(dstData.content).toBe("# My Project\n");

    // Cleanup.
    await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "README-copy.md",
    });
  });

  it("workspace.copyPath copies a directory recursively", async () => {
    await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "repo-main",
      path: "to-copy",
    });
    await trpcMutate(server.url, "workspace.createFile", {
      workspaceId: "repo-main",
      path: "to-copy/inside.txt",
      content: "nested\n",
    });

    const res = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: "to-copy",
      toPath: "copied",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ kind: string }>(res);
    expect(data.kind).toBe("directory");

    // Verify the nested file landed at the new path with its content.
    const innerRes = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "repo-main",
      path: "copied/inside.txt",
    });
    const innerData = await trpcData<{ content: string }>(innerRes);
    expect(innerData.content).toBe("nested\n");

    // Cleanup both source and copy.
    await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "to-copy",
    });
    await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "copied",
    });
  });

  it("workspace.copyPath rejects copying onto an existing destination", async () => {
    const res = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: "README.md",
      toPath: "src",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already exists/);
  });

  it("workspace.copyPath rejects copying a directory into its descendant", async () => {
    await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "repo-main",
      path: "outer",
    });
    await trpcMutate(server.url, "workspace.createDirectory", {
      workspaceId: "repo-main",
      path: "outer/inner",
    });

    const res = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: "outer",
      toPath: "outer/inner/copy",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/into itself/);

    await trpcMutate(server.url, "workspace.deletePath", {
      workspaceId: "repo-main",
      path: "outer",
    });
  });

  it("workspace.copyPath rejects missing source", async () => {
    const res = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: "no-such-file.txt",
      toPath: "anywhere.txt",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/does not exist/);
  });

  it("workspace.copyPath rejects path traversal on the source", async () => {
    const res = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: "../README.md",
      toPath: "elsewhere.txt",
    });
    expect(res.status).toBe(500);
  });

  it("workspace.copyPath rejects path traversal on the destination", async () => {
    const res = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: "README.md",
      toPath: "../escape.txt",
    });
    expect(res.status).toBe(500);
  });

  it("workspace.copyPath refuses to copy .git internals", async () => {
    const res = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: ".git",
      toPath: "git-backup",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/\.git/);
  });

  it("workspace.copyPath rejects identical source and destination", async () => {
    const res = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: "README.md",
      toPath: "README.md",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/same/);
  });

  it("workspace.copyPath rejects empty paths", async () => {
    const emptyFrom = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: "",
      toPath: "x.txt",
    });
    expect(emptyFrom.status).toBe(400);

    const emptyTo = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "repo-main",
      fromPath: "README.md",
      toPath: "",
    });
    expect(emptyTo.status).toBe(400);
  });

  it("workspace.copyPath rejects unknown workspace", async () => {
    const res = await trpcMutate(server.url, "workspace.copyPath", {
      workspaceId: "nonexistent-main",
      fromPath: "README.md",
      toPath: "x.md",
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
      compareBranch: string;
      defaultBranch: string;
      headBranch: string;
      fileStatuses: Record<string, string>;
    }>(res);
    expect(data.compareBranch).toBe("main");
    expect(data.defaultBranch).toBe("main");
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

  // -- workspace.listBranches --

  it("workspace.listBranches returns branches with default first and current excluded", async () => {
    // feature-1 worktree should already exist from earlier tests in this describe block.
    const res = await trpcQuery(server.url, "workspace.listBranches", {
      workspaceId: "repo-feature-1",
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

  it("workspace.listBranches omits default when on the default branch", async () => {
    // On the default branch, comparing against `main` is a no-op, so the
    // server skips re-adding it to the list.
    const res = await trpcQuery(server.url, "workspace.listBranches", {
      workspaceId: "repo-main",
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

  // -- workspace.getDiff with compareBranch --

  it("workspace.getDiff with non-default compareBranch uses merge-base of that branch", async () => {
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

    // Create a fresh feature workspace off main.
    const createRes = await trpcMutate(server.url, "workspaces.create", {
      project: "repo",
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
    const developRes = await trpcQuery(server.url, "workspace.getDiff", {
      workspaceId: "repo-feature-cmp",
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
    const mainRes = await trpcQuery(server.url, "workspace.getDiff", {
      workspaceId: "repo-feature-cmp",
      diffMode: "branch",
      compareBranch: "main",
    });
    expect(mainRes.status).toBe(200);
    const mainData = await trpcData<{ compareBranch: string }>(mainRes);
    expect(mainData.compareBranch).toBe("main");
  });

  it("workspace.getDiff rejects compareBranch starting with '-'", async () => {
    // Defense-in-depth against branch names that git would treat as flags
    // (e.g. `--upload-pack=`, `--exec=`).
    const res = await trpcQuery(server.url, "workspace.getDiff", {
      workspaceId: "repo-feature-cmp",
      diffMode: "branch",
      compareBranch: "--exec=bad",
    });
    expect(res.status).toBe(400);
  });

  // -- workspace.revertFile with compareBranch --

  it("workspace.revertFile uses compareBranch when in branch mode", async () => {
    // Use the feature-cmp workspace from the previous test. Modify a file
    // that exists on the merge-base of `develop`/HEAD, then revert in
    // branch mode against `develop` — it should restore the file.
    const listRes = await trpcQuery(server.url, "projects.list");
    const listData = await trpcData<{
      projects: Array<{ worktrees: Array<{ branch: string; path: string }> }>;
    }>(listRes);
    const featureCmp = listData.projects[0].worktrees.find((wt) => wt.branch === "feature-cmp");
    expect(featureCmp).toBeDefined();

    // Modify README.md (which exists at the merge-base).
    writeFileSync(join(featureCmp!.path, "README.md"), "# Modified\n");
    git(featureCmp!.path, ["add", "README.md"]);
    git(featureCmp!.path, ["commit", "-m", "modify readme"]);

    const revertRes = await trpcMutate(server.url, "workspace.revertFile", {
      workspaceId: "repo-feature-cmp",
      filePath: "README.md",
      diffMode: "branch",
      compareBranch: "develop",
    });
    expect(revertRes.status).toBe(200);
    const revertData = await trpcData<{ ok: boolean }>(revertRes);
    expect(revertData.ok).toBe(true);

    // After revert, the working tree should match the merge-base content.
    const fileRes = await trpcQuery(server.url, "workspace.getFile", {
      workspaceId: "repo-feature-cmp",
      path: "README.md",
    });
    expect(fileRes.status).toBe(200);
    const fileData = await trpcData<{ content: string }>(fileRes);
    expect(fileData.content).toBe("# My Project\n");
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
// Pinned workspaces
// ---------------------------------------------------------------------------

describe("tRPC — pinned workspaces", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;
  let mainWorktreePath: string;
  let featureWorktreePath: string;

  // Helper: extract a worktree's pinned flag via projects.list.
  async function readPinned(branch: string): Promise<boolean | undefined> {
    const res = await trpcQuery(server.url, "projects.list");
    const data = await trpcData<{
      projects: Array<{ name: string; worktrees: Array<{ branch: string; pinned: boolean }> }>;
    }>(res);
    return data.projects[0]?.worktrees.find((w) => w.branch === branch)?.pinned;
  }

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Create the project repo + a second worktree on `feature` so we have
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
      projects: [
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
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    try {
      git(repoPath, ["worktree", "remove", "--force", featureWorktreePath]);
    } catch {
      // best-effort — fine if the test crashed before the worktree was created,
      // or if it was already cleaned up
    }
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("projects.list returns pinned: false by default", async () => {
    expect(await readPinned("main")).toBe(false);
    expect(await readPinned("feature")).toBe(false);
  });

  it("workspaces.setPinned pins a workspace and projects.list reflects it", async () => {
    const res = await trpcMutate(server.url, "workspaces.setPinned", {
      project: "pin-repo",
      branch: "feature",
      pinned: true,
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);

    expect(await readPinned("feature")).toBe(true);
    // Pinning one workspace must not affect siblings.
    expect(await readPinned("main")).toBe(false);
  });

  it("workspaces.setPinned unpins a previously pinned workspace", async () => {
    const res = await trpcMutate(server.url, "workspaces.setPinned", {
      project: "pin-repo",
      branch: "feature",
      pinned: false,
    });
    expect(res.status).toBe(200);
    expect(await readPinned("feature")).toBe(false);
  });

  it("workspaces.setPinned returns an error for unknown project", async () => {
    const res = await trpcMutate(server.url, "workspaces.setPinned", {
      project: "no-such-project",
      branch: "feature",
      pinned: true,
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("not found");
  });

  it("workspaces.setPinned returns an error for unknown branch", async () => {
    const res = await trpcMutate(server.url, "workspaces.setPinned", {
      project: "pin-repo",
      branch: "no-such-branch",
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
    let res = await trpcMutate(server.url, "workspaces.setPinned", {
      project: "pin-repo",
      branch: "feature",
      pinned: true,
    });
    expect(res.status).toBe(200);

    res = await trpcMutate(server.url, "workspaces.create", {
      project: "pin-repo",
      branch: "sibling",
    });
    expect(res.status).toBe(200);

    expect(await readPinned("feature")).toBe(true);
    expect(await readPinned("sibling")).toBe(false);

    // Clean up: unpin and remove the sibling so the next test starts clean.
    await trpcMutate(server.url, "workspaces.setPinned", {
      project: "pin-repo",
      branch: "feature",
      pinned: false,
    });
    await trpcMutate(server.url, "workspaces.remove", {
      project: "pin-repo",
      branch: "sibling",
    });
  });

  it("pinned state persists across server restart", async () => {
    const res = await trpcMutate(server.url, "workspaces.setPinned", {
      project: "pin-repo",
      branch: "feature",
      pinned: true,
    });
    expect(res.status).toBe(200);

    // Restart the server with the same HOME — the on-disk SQLite is the
    // only persistence layer for pin state, so a fresh process must see
    // the same value.
    await server.close();
    server = await startServer({ tmpHome });

    expect(await readPinned("feature")).toBe(true);
    expect(await readPinned("main")).toBe(false);
  });

  it("workspaces.remove drops the pinned worktree's row", async () => {
    // Pin `feature` explicitly so this test owns its preconditions
    // and doesn't depend on prior tests in the describe block.
    let res = await trpcMutate(server.url, "workspaces.setPinned", {
      project: "pin-repo",
      branch: "feature",
      pinned: true,
    });
    expect(res.status).toBe(200);

    res = await trpcMutate(server.url, "workspaces.remove", {
      project: "pin-repo",
      branch: "feature",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "projects.list");
    const data = await trpcData<{
      projects: Array<{ worktrees: Array<{ branch: string }> }>;
    }>(listRes);
    const branches = data.projects[0].worktrees.map((w) => w.branch);
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
    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
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
  workspaceId: string;
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
    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // Each test gets its own workspaceId so suites stay independent — the
  // server keeps the DB across tests (it's process-lifetime), so two
  // tests that both wrote to "wsA" would otherwise leak state.
  let wsCounter = 0;
  function freshWorkspace(): string {
    wsCounter += 1;
    return `ws-history-${wsCounter}`;
  }

  it("history.record inserts a new entry for a workspace", async () => {
    const ws = freshWorkspace();
    const recRes = await trpcMutate(server.url, "history.record", {
      workspaceId: ws,
      url: "https://example.com/",
      title: "Example",
    });
    expect(recRes.status).toBe(200);

    const listRes = await trpcQuery(server.url, "history.list", { workspaceId: ws });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].url).toBe("https://example.com/");
    expect(data.entries[0].title).toBe("Example");
    expect(data.entries[0].visitCount).toBe(1);
  });

  it("history.record dedupes by (workspaceId, url) and bumps visit count", async () => {
    const ws = freshWorkspace();
    const url = "https://example.com/dedupe";

    for (let i = 0; i < 3; i += 1) {
      const res = await trpcMutate(server.url, "history.record", { workspaceId: ws, url });
      expect(res.status).toBe(200);
      // Small sleep so `lastVisitedAt` strictly increases (clock
      // resolution can otherwise compress two writes onto the same ms).
      await new Promise((r) => setTimeout(r, 2));
    }

    const listRes = await trpcQuery(server.url, "history.list", { workspaceId: ws });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].visitCount).toBe(3);
  });

  it("history.record filters disallowed URL schemes", async () => {
    const ws = freshWorkspace();

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
      const res = await trpcMutate(server.url, "history.record", { workspaceId: ws, url });
      expect(res.status).toBe(200);
      const body = await trpcData<{ recorded: boolean }>(res);
      expect(body.recorded).toBe(false);
    }

    const listRes = await trpcQuery(server.url, "history.list", { workspaceId: ws });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(data.entries).toHaveLength(0);
  });

  it("history.updateMeta backfills title and favicon on an existing entry", async () => {
    const ws = freshWorkspace();
    const url = "https://example.com/meta";

    await trpcMutate(server.url, "history.record", { workspaceId: ws, url });

    const res = await trpcMutate(server.url, "history.updateMeta", {
      workspaceId: ws,
      url,
      title: "Late-arriving title",
      faviconUrl: "https://example.com/favicon.ico",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "history.list", { workspaceId: ws });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(data.entries[0].title).toBe("Late-arriving title");
    expect(data.entries[0].faviconUrl).toBe("https://example.com/favicon.ico");
  });

  it("history.updateMeta is a no-op when no matching row exists", async () => {
    const ws = freshWorkspace();
    const res = await trpcMutate(server.url, "history.updateMeta", {
      workspaceId: ws,
      url: "https://nothing.example/",
      title: "Phantom",
    });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "history.list", { workspaceId: ws });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(data.entries).toHaveLength(0);
  });

  it("history.list returns entries in recency order and is workspace-scoped", async () => {
    const wsA = freshWorkspace();
    const wsB = freshWorkspace();

    await trpcMutate(server.url, "history.record", {
      workspaceId: wsA,
      url: "https://a.example/first",
    });
    await new Promise((r) => setTimeout(r, 2));
    await trpcMutate(server.url, "history.record", {
      workspaceId: wsA,
      url: "https://a.example/second",
    });
    await new Promise((r) => setTimeout(r, 2));
    await trpcMutate(server.url, "history.record", {
      workspaceId: wsB,
      url: "https://b.example/only",
    });

    const aRes = await trpcQuery(server.url, "history.list", { workspaceId: wsA });
    const aData = await trpcData<{ entries: HistoryEntryShape[] }>(aRes);
    expect(aData.entries.map((e) => e.url)).toEqual([
      "https://a.example/second",
      "https://a.example/first",
    ]);

    const bRes = await trpcQuery(server.url, "history.list", { workspaceId: wsB });
    const bData = await trpcData<{ entries: HistoryEntryShape[] }>(bRes);
    expect(bData.entries.map((e) => e.url)).toEqual(["https://b.example/only"]);
  });

  it("history.search matches on URL and title and ranks by frecency", async () => {
    const ws = freshWorkspace();

    // High-frecency: recorded 5 times, very recent.
    for (let i = 0; i < 5; i += 1) {
      await trpcMutate(server.url, "history.record", {
        workspaceId: ws,
        url: "https://docs.example.com/frequent",
        title: "Docs frequent page",
      });
      await new Promise((r) => setTimeout(r, 2));
    }

    // Low-frecency: recorded once, equally recent.
    await trpcMutate(server.url, "history.record", {
      workspaceId: ws,
      url: "https://docs.example.com/rare",
      title: "Other rare page",
    });

    // Title-only match — substring match on title, not URL.
    await trpcMutate(server.url, "history.record", {
      workspaceId: ws,
      url: "https://misc.example.com/whatever",
      title: "Docs by title only",
    });

    const res = await trpcQuery(server.url, "history.search", {
      workspaceId: ws,
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
    const ws = freshWorkspace();
    await trpcMutate(server.url, "history.record", {
      workspaceId: ws,
      url: "https://example.org/",
    });
    const res = await trpcQuery(server.url, "history.search", { workspaceId: ws, query: "" });
    const data = await trpcData<{ entries: HistoryEntryShape[] }>(res);
    expect(data.entries).toEqual([]);
  });

  it("history.delete removes a single entry by id", async () => {
    const ws = freshWorkspace();
    await trpcMutate(server.url, "history.record", {
      workspaceId: ws,
      url: "https://a.example/keep",
    });
    await trpcMutate(server.url, "history.record", {
      workspaceId: ws,
      url: "https://a.example/delete",
    });

    const listRes = await trpcQuery(server.url, "history.list", { workspaceId: ws });
    const listData = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    const toDelete = listData.entries.find((e) => e.url.endsWith("/delete"));
    expect(toDelete).toBeDefined();

    const delRes = await trpcMutate(server.url, "history.delete", { id: toDelete!.id });
    expect(delRes.status).toBe(200);

    const afterRes = await trpcQuery(server.url, "history.list", { workspaceId: ws });
    const afterData = await trpcData<{ entries: HistoryEntryShape[] }>(afterRes);
    expect(afterData.entries.map((e) => e.url)).toEqual(["https://a.example/keep"]);
  });

  it("history.clear with range 'all' wipes only the target workspace", async () => {
    const wsA = freshWorkspace();
    const wsB = freshWorkspace();

    await trpcMutate(server.url, "history.record", {
      workspaceId: wsA,
      url: "https://a.example/x",
    });
    await trpcMutate(server.url, "history.record", {
      workspaceId: wsB,
      url: "https://b.example/y",
    });

    const clearRes = await trpcMutate(server.url, "history.clear", {
      workspaceId: wsA,
      range: "all",
    });
    expect(clearRes.status).toBe(200);
    const clearData = await trpcData<{ deleted: number }>(clearRes);
    expect(clearData.deleted).toBe(1);

    const aListRes = await trpcQuery(server.url, "history.list", { workspaceId: wsA });
    const aListData = await trpcData<{ entries: HistoryEntryShape[] }>(aListRes);
    expect(aListData.entries).toEqual([]);

    const bListRes = await trpcQuery(server.url, "history.list", { workspaceId: wsB });
    const bListData = await trpcData<{ entries: HistoryEntryShape[] }>(bListRes);
    expect(bListData.entries).toHaveLength(1);
  });

  it("history.clear with range 'hour' only deletes recent entries", async () => {
    const ws = freshWorkspace();

    // Seed a fresh row (recorded now).
    await trpcMutate(server.url, "history.record", {
      workspaceId: ws,
      url: "https://example.com/recent",
    });

    const clearRes = await trpcMutate(server.url, "history.clear", {
      workspaceId: ws,
      range: "hour",
    });
    expect(clearRes.status).toBe(200);
    const clearData = await trpcData<{ deleted: number }>(clearRes);
    expect(clearData.deleted).toBe(1);

    // Verify the row is gone.
    const listRes = await trpcQuery(server.url, "history.list", { workspaceId: ws });
    const listData = await trpcData<{ entries: HistoryEntryShape[] }>(listRes);
    expect(listData.entries).toEqual([]);
  });

  it("history.clear rejects an unknown range", async () => {
    const ws = freshWorkspace();
    const res = await trpcMutate(server.url, "history.clear", {
      workspaceId: ws,
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
