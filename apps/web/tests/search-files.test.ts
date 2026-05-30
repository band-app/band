import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "search-files-test-token";

// ---------------------------------------------------------------------------
// Black-box integration tests for `workspace.searchFiles` — the procedure
// powering the Cmd+P Quick Open file picker. The previous implementation
// shelled out to `git ls-files --cached --others --exclude-standard`, which
// silently dropped files inside nested git repositories / submodules
// because `git ls-files` refuses to cross repo boundaries (issue #530).
//
// The replacement uses `rg --files` so the walker descends into nested
// repos while still respecting `.gitignore` and excluding `node_modules`
// / `.git` internals. These tests boot the real server (same bundle that
// ships to users) against a temp workspace that contains a nested git
// repo and pin both the new positive behaviour and the unchanged
// exclusion semantics.
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-search-files-test-")));
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
        reject(new Error(`Server did not start within 15s.\nstderr: ${stderr}`));
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

describe("tRPC — workspace.searchFiles", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Outer workspace: a real git repo with a tracked file.
    repoPath = join(tmpHome, "outer");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "outer.ts"), "// outer\n");
    writeFileSync(join(repoPath, "flow-source-composite.ts"), "// flow composite\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial"]);

    // Nested git repo — this is the issue #530 scenario. `git ls-files`
    // run from `outer` would refuse to descend into `nested/.git`, so
    // every file inside `nested/` (including the deeply nested
    // `nested/src/inside-nested.ts`) was invisible to Quick Open.
    const nestedPath = join(repoPath, "nested");
    mkdirSync(join(nestedPath, "src"), { recursive: true });
    git(nestedPath, ["init", "-b", "main"]);
    writeFileSync(join(nestedPath, "nested-root.ts"), "// nested root\n");
    writeFileSync(join(nestedPath, "src", "inside-nested.ts"), "// inside nested\n");
    git(nestedPath, ["add", "."]);
    git(nestedPath, ["commit", "-m", "nested initial"]);

    // node_modules — must remain hidden. The `.gitignore`-equivalent
    // exclusion was guaranteed by `git ls-files --exclude-standard`; the
    // replacement adds an explicit `-g '!**/node_modules'` glob.
    const nmPath = join(repoPath, "node_modules", "noise-pkg");
    mkdirSync(nmPath, { recursive: true });
    writeFileSync(join(nmPath, "noise.ts"), "// should never surface in Quick Open\n");

    // .gitignored file — should remain hidden because ripgrep respects
    // `.gitignore` by default.
    writeFileSync(join(repoPath, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(repoPath, "ignored.ts"), "// ignored\n");
    git(repoPath, ["add", ".gitignore"]);
    git(repoPath, ["commit", "-m", "gitignore"]);

    seedState(tmpHome, {
      projects: [
        {
          name: "outer",
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

  it("surfaces files inside nested git repositories (issue #530)", async () => {
    const res = await trpcQuery(server.url, "workspace.searchFiles", {
      workspaceId: "outer-main",
      query: "",
    });
    expect(res.status).toBe(200);

    const { files } = await trpcData<{ files: string[] }>(res);

    // Both the outer-repo file and the nested-repo files must be in the
    // listing. The pre-fix behaviour included only `outer.ts`.
    expect(files).toContain("outer.ts");
    expect(files).toContain("nested/nested-root.ts");
    expect(files).toContain("nested/src/inside-nested.ts");
  });

  it("excludes node_modules and .gitignored paths", async () => {
    const res = await trpcQuery(server.url, "workspace.searchFiles", {
      workspaceId: "outer-main",
      query: "",
    });
    const { files } = await trpcData<{ files: string[] }>(res);

    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(files).not.toContain("ignored.ts");
    // The `.git` directory itself must not leak into results.
    expect(files.some((f) => f.startsWith(".git/"))).toBe(false);
    expect(files.some((f) => f.startsWith("nested/.git/"))).toBe(false);
  });

  it("ranks the substring match first for the issue #530 example query", async () => {
    // The exact scenario reported in issue #530: searching `composite`
    // should put `flow-source-composite.ts` at (or very near) the top,
    // even when scattered subsequence matches exist elsewhere.
    const res = await trpcQuery(server.url, "workspace.searchFiles", {
      workspaceId: "outer-main",
      query: "composite",
    });
    const { files } = await trpcData<{ files: string[] }>(res);
    expect(files[0]).toBe("flow-source-composite.ts");
  });

  it("respects the limit parameter", async () => {
    const res = await trpcQuery(server.url, "workspace.searchFiles", {
      workspaceId: "outer-main",
      query: "",
      limit: 2,
    });
    const { files } = await trpcData<{ files: string[] }>(res);
    expect(files.length).toBe(2);
  });

  it("returns an error for an unknown workspace", async () => {
    const res = await trpcQuery(server.url, "workspace.searchFiles", {
      workspaceId: "nonexistent-main",
      query: "",
    });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// `searchFiles` against a non-git workspace. The previous `git ls-files`
// implementation would fail outright in this case; ripgrep's
// `--no-require-git` makes the procedure work for plain directories too.
// ---------------------------------------------------------------------------
describe("tRPC — workspace.searchFiles in non-git directories", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainDir: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    plainDir = join(tmpHome, "plain");
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, "note.md"), "# plain note\n");

    seedState(tmpHome, {
      projects: [
        {
          name: "plain",
          path: plainDir,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: plainDir }],
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

  it("lists files in a workspace that is not a git repository", async () => {
    const res = await trpcQuery(server.url, "workspace.searchFiles", {
      workspaceId: "plain-main",
      query: "",
    });
    expect(res.status).toBe(200);
    const { files } = await trpcData<{ files: string[] }>(res);
    expect(files).toContain("note.md");
  });
});
