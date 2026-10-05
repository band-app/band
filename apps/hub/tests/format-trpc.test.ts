import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";

// End-to-end test for `worktree.formatFile`: boots the real server, drives
// the procedure over HTTP, asserts success / soft-skip / hard-error paths.
// The procedure is pure — content goes in, formatted content comes back —
// so the test deliberately confirms the *on-disk* file is left alone.

const _PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "format-trpc-test-token";

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcMutate(serverUrl: string, procedure: string, input: unknown) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { ...defaultHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

interface TrpcSuccess<T> {
  result: { data: T };
}
interface TrpcError {
  error: { message: string };
}

async function readTrpcBody<T>(res: Response): Promise<TrpcSuccess<T> | TrpcError> {
  return (await res.json()) as TrpcSuccess<T> | TrpcError;
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

describe("worktree.formatFile (tRPC)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-format-trpc-test-");

    repoPath = join(tmpHome, "repo");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "README.md"), "# Test\n");
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

  it("formats a JS string via Prettier and leaves the file on disk untouched", async () => {
    // Drop a *different* on-disk version to prove the server formats the
    // in-memory `content` we send, not whatever happens to be on disk.
    const target = join(repoPath, "messy.js");
    writeFileSync(target, "// stale on-disk version\n");

    const res = await trpcMutate(server.url, "worktree.formatFile", {
      worktreeId: "repo-main",
      filePath: target,
      content: "const   a={x:1,y:2}\n",
    });
    expect(res.status).toBe(200);
    const body = await readTrpcBody<{
      skipped: false;
      parser: string;
      formatted: string;
      changed: boolean;
    }>(res);
    if ("error" in body) throw new Error(`unexpected error: ${body.error.message}`);

    expect(body.result.data.skipped).toBe(false);
    expect(body.result.data.parser).toBe("babel");
    expect(body.result.data.changed).toBe(true);
    expect(body.result.data.formatted).toContain("const a = { x: 1, y: 2 };");
    // Disk untouched.
    expect(readFileSync(target, "utf-8")).toBe("// stale on-disk version\n");
  });

  it("returns skipped=true for unsupported file extensions", async () => {
    const target = join(repoPath, "blob.bin");
    const res = await trpcMutate(server.url, "worktree.formatFile", {
      worktreeId: "repo-main",
      filePath: target,
      content: "anything",
    });
    expect(res.status).toBe(200);
    const body = await readTrpcBody<{ skipped: true; reason: string }>(res);
    if ("error" in body) throw new Error(`unexpected error: ${body.error.message}`);
    expect(body.result.data.skipped).toBe(true);
    expect(body.result.data.reason).toMatch(/no parser/i);
  });

  it("returns changed=false when input is already formatted", async () => {
    const target = join(repoPath, "clean.js");
    const res = await trpcMutate(server.url, "worktree.formatFile", {
      worktreeId: "repo-main",
      filePath: target,
      content: "const a = 1;\n",
    });
    expect(res.status).toBe(200);
    const body = await readTrpcBody<{
      skipped: false;
      changed: boolean;
      formatted: string;
    }>(res);
    if ("error" in body) throw new Error(`unexpected error: ${body.error.message}`);
    expect(body.result.data.skipped).toBe(false);
    expect(body.result.data.changed).toBe(false);
    expect(body.result.data.formatted).toBe("const a = 1;\n");
  });

  it("rejects requests for an unknown worktree with 404", async () => {
    const res = await trpcMutate(server.url, "worktree.formatFile", {
      worktreeId: "does-not-exist",
      filePath: join(repoPath, "messy.js"),
      content: "const a=1\n",
    });
    expect(res.status).toBe(404);
  });

  it("surfaces Prettier syntax errors as 400", async () => {
    const target = join(repoPath, "broken.ts");
    const res = await trpcMutate(server.url, "worktree.formatFile", {
      worktreeId: "repo-main",
      filePath: target,
      content: "const x: =;\n",
    });
    expect(res.status).toBe(400);
    const body = await readTrpcBody<unknown>(res);
    if (!("error" in body)) throw new Error("expected error response");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("respects a .prettierrc dropped into the worktree", async () => {
    writeFileSync(join(repoPath, ".prettierrc"), JSON.stringify({ singleQuote: true }));
    const target = join(repoPath, "quotes.js");

    const res = await trpcMutate(server.url, "worktree.formatFile", {
      worktreeId: "repo-main",
      filePath: target,
      content: `const s = "hello";\n`,
    });
    expect(res.status).toBe(200);
    const body = await readTrpcBody<{
      skipped: false;
      formatted: string;
      changed: boolean;
    }>(res);
    if ("error" in body) throw new Error(`unexpected error: ${body.error.message}`);
    expect(body.result.data.skipped).toBe(false);
    expect(body.result.data.changed).toBe(true);
    expect(body.result.data.formatted).toBe(`const s = 'hello';\n`);
  });

  it("formats files that don't exist on disk yet (untitled / unsaved buffers)", async () => {
    const target = join(repoPath, "brand-new-never-saved.ts");
    const res = await trpcMutate(server.url, "worktree.formatFile", {
      worktreeId: "repo-main",
      filePath: target,
      content: "const a:number=1\n",
    });
    expect(res.status).toBe(200);
    const body = await readTrpcBody<{
      skipped: false;
      formatted: string;
    }>(res);
    if ("error" in body) throw new Error(`unexpected error: ${body.error.message}`);
    expect(body.result.data.skipped).toBe(false);
    expect(body.result.data.formatted).toBe("const a: number = 1;\n");
  });
});
