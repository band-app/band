import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "search-content-test-token";

// ---------------------------------------------------------------------------
// Helpers (duplicated from trpc.test.ts to keep this file independent — the
// existing helpers there are not exported as a module)
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-search-test-")));
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

type SearchResult = { file: string; line: number; content: string };

// ---------------------------------------------------------------------------
// workspace.searchContent — verifies the ripgrep-backed find-in-files
// procedure finds both tracked and untracked files (the original `git grep`
// implementation silently dropped untracked files; see issue #431).
// ---------------------------------------------------------------------------

describe("tRPC — workspace.searchContent (ripgrep)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Real git repo with one tracked file containing the marker.
    repoPath = join(tmpHome, "repo");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "tracked.txt"), "tracked-file BAND_RG_MARKER hello\n");
    git(repoPath, ["add", "tracked.txt"]);
    git(repoPath, ["commit", "-m", "initial"]);

    // Untracked file (matches what coding agents create before `git add`).
    writeFileSync(join(repoPath, "untracked.txt"), "untracked-file BAND_RG_MARKER world\n");

    // A real subdirectory with another tracked file to verify subdirectory
    // discovery still works.
    mkdirSync(join(repoPath, "src"));
    writeFileSync(
      join(repoPath, "src", "deep.txt"),
      "deep tracked BAND_RG_MARKER nested content\n",
    );
    git(repoPath, ["add", "src/deep.txt"]);
    git(repoPath, ["commit", "-m", "deep file"]);

    // A file matching .gitignore should NOT appear in results.
    writeFileSync(join(repoPath, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repoPath, "ignored.txt"), "ignored BAND_RG_MARKER skip\n");

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

  it("returns matches from both tracked and untracked files", async () => {
    const res = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "repo-main",
      query: "BAND_RG_MARKER",
    });
    expect(res.status).toBe(200);

    const { results } = await trpcData<{ results: SearchResult[] }>(res);
    const files = new Set(results.map((r) => r.file));

    expect(files.has("tracked.txt")).toBe(true);
    expect(files.has("untracked.txt")).toBe(true);
    expect(files.has("src/deep.txt")).toBe(true);

    // Every result must include the marker in its content and a 1-based line number.
    for (const r of results) {
      expect(r.content).toContain("BAND_RG_MARKER");
      expect(r.line).toBeGreaterThan(0);
    }
  });

  it("respects .gitignore and excludes ignored files", async () => {
    const res = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "repo-main",
      query: "BAND_RG_MARKER",
    });
    const { results } = await trpcData<{ results: SearchResult[] }>(res);
    expect(results.some((r) => r.file === "ignored.txt")).toBe(false);
  });

  it("supports case-sensitive search", async () => {
    // Lowercase query, case-insensitive (default): matches the uppercase marker.
    const insensitive = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "repo-main",
      query: "band_rg_marker",
    });
    const insensitiveData = await trpcData<{ results: SearchResult[] }>(insensitive);
    expect(insensitiveData.results.length).toBeGreaterThan(0);

    // Same query case-sensitive: no matches.
    const sensitive = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "repo-main",
      query: "band_rg_marker",
      caseSensitive: true,
    });
    const sensitiveData = await trpcData<{ results: SearchResult[] }>(sensitive);
    expect(sensitiveData.results.length).toBe(0);
  });

  it("supports whole-word matching", async () => {
    // The tracked.txt content is "tracked-file BAND_RG_MARKER hello". The
    // word "hello" matches as a whole word; "ello" should not when wholeWord
    // is true.
    const wholeWordMatch = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "repo-main",
      query: "hello",
      wholeWord: true,
    });
    const matchData = await trpcData<{ results: SearchResult[] }>(wholeWordMatch);
    expect(matchData.results.some((r) => r.file === "tracked.txt")).toBe(true);

    const wholeWordMiss = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "repo-main",
      query: "ello",
      wholeWord: true,
    });
    const missData = await trpcData<{ results: SearchResult[] }>(wholeWordMiss);
    expect(missData.results.some((r) => r.file === "tracked.txt")).toBe(false);
  });

  it("treats fixed-string queries literally (regex disabled)", async () => {
    // A regex meta-character that would match anything in regex mode. With
    // fixed strings (the default), it should match literally and find nothing.
    const literal = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "repo-main",
      query: "BAND.*MARKER",
    });
    const literalData = await trpcData<{ results: SearchResult[] }>(literal);
    expect(literalData.results.length).toBe(0);

    // Same query with regex enabled should match all marker lines.
    const regex = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "repo-main",
      query: "BAND.*MARKER",
      regex: true,
    });
    const regexData = await trpcData<{ results: SearchResult[] }>(regex);
    expect(regexData.results.length).toBeGreaterThan(0);
  });

  it("respects the limit parameter", async () => {
    const res = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "repo-main",
      query: "BAND_RG_MARKER",
      limit: 1,
    });
    const { results } = await trpcData<{ results: SearchResult[] }>(res);
    expect(results.length).toBe(1);
  });

  it("returns an empty result set when there are no matches", async () => {
    const res = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "repo-main",
      query: "this-string-does-not-exist-anywhere-in-the-repo-zzz",
    });
    expect(res.status).toBe(200);
    const { results } = await trpcData<{ results: SearchResult[] }>(res);
    expect(results).toEqual([]);
  });

  it("returns an error for an unknown workspace", async () => {
    const res = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "nonexistent-main",
      query: "anything",
    });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// workspace.searchContent — non-git workspaces.
//
// ripgrep does not require a git repository (unlike `git grep`). Verify the
// procedure works for plain directories that contain files.
// ---------------------------------------------------------------------------

describe("tRPC — workspace.searchContent in non-git directories", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let plainDir: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    plainDir = join(tmpHome, "plain");
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, "file.txt"), "plain BAND_PLAIN_MARKER content\n");

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

  it("finds files in a workspace that is not a git repository", async () => {
    const res = await trpcQuery(server.url, "workspace.searchContent", {
      workspaceId: "plain-main",
      query: "BAND_PLAIN_MARKER",
    });
    expect(res.status).toBe(200);
    const { results } = await trpcData<{ results: SearchResult[] }>(res);
    expect(results.some((r) => r.file === "file.txt")).toBe(true);
  });
});
