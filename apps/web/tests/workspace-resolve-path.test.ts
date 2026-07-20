// Integration tests for the `workspace.resolvePath` tRPC query that backs
// Quick Open's "open a file by absolute path" affordance.
//
// We exercise the real server pipeline: spawn the production server in a
// child process, seed a workspace whose worktree is a real on-disk dir, then
// call the procedure over HTTP. The assertions pin the full response shape
// for the branches the resolver owns — a path inside the worktree (→
// workspace-relative), a path outside it (→ external), a non-existent path, a
// directory (not a regular file), and the unauthenticated 401 gate. No mocks;
// the only seam is the band_token cookie the rest of the integration suite
// uses. Mirrors the server/tRPC helpers in `host-file.test.ts`.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "workspace-resolve-path-test-token";
const PROJECT = "resolve-path-project";
const BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

// ---------------------------------------------------------------------------
// Server helpers (copied from host-file.test.ts to keep the file self-contained)
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-resolve-path-test-")));
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
  const home = opts.tmpHome;
  const port = await getRandomPort();
  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, HOME: home, PORT: String(port), NODE_ENV: "production" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening") && !settled) {
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

interface ResolvePathResult {
  exists: boolean;
  isFile: boolean;
  external: boolean;
  workspaceRelativePath: string | null;
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

async function resolvePath(serverUrl: string, path: string): Promise<ResolvePathResult> {
  const res = await trpcQuery(serverUrl, "workspace.resolvePath", { workspaceId: WORKSPACE, path });
  expect(res.status).toBe(200);
  return trpcData<ResolvePathResult>(res);
}

// ---------------------------------------------------------------------------
// workspace.resolvePath
// ---------------------------------------------------------------------------

describe("tRPC — workspace.resolvePath", () => {
  let server: ServerHandle;
  let tmpHome: string;
  // The worktree is a real on-disk directory so stat() sees real files.
  let worktree: string;
  let insideDir: string;
  let insideFile: string;
  // An "outside" dir next to the worktree, modelling a path no workspace
  // would contain (e.g. a `/tmp/notes.md` a user pastes in).
  let outsideDir: string;
  let outsideFile: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    worktree = realpathSync(mkdtempSync(join(tmpdir(), "band-resolve-path-worktree-")));
    insideDir = join(worktree, "src");
    mkdirSync(insideDir, { recursive: true });
    insideFile = join(insideDir, "inside.ts");
    writeFileSync(insideFile, "export const inside = 1;\n", "utf-8");

    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "band-resolve-path-outside-")));
    outsideFile = join(outsideDir, "notes.md");
    writeFileSync(outsideFile, "# notes\n", "utf-8");

    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: worktree,
          defaultBranch: BRANCH,
          worktrees: [{ branch: BRANCH, path: worktree }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("resolves an absolute path INSIDE the worktree to its workspace-relative form", async () => {
    const data = await resolvePath(server.url, insideFile);
    expect(data).toEqual({
      exists: true,
      isFile: true,
      external: false,
      // POSIX-separated, relative to the worktree root.
      workspaceRelativePath: "src/inside.ts",
    });
  });

  it("resolves an absolute path OUTSIDE the worktree as external", async () => {
    const data = await resolvePath(server.url, outsideFile);
    expect(data).toEqual({
      exists: true,
      isFile: true,
      external: true,
      workspaceRelativePath: null,
    });
  });

  it("reports a non-existent absolute path as not existing", async () => {
    const data = await resolvePath(server.url, join(outsideDir, "does-not-exist.md"));
    expect(data.exists).toBe(false);
    expect(data.isFile).toBe(false);
  });

  it("reports a directory as existing but not a regular file", async () => {
    const data = await resolvePath(server.url, insideDir);
    expect(data).toEqual({
      exists: true,
      isFile: false,
      external: false,
      workspaceRelativePath: "src",
    });
  });

  it("rejects unauthenticated callers", async () => {
    // resolvePath reports on arbitrary absolute paths, so the transport-layer
    // band_token is the only gate. Pin 401 specifically (a generic non-200
    // would also pass on a crash 500).
    const res = await fetch(
      `${server.url}/trpc/workspace.resolvePath?input=${encodeURIComponent(
        JSON.stringify({ workspaceId: WORKSPACE, path: outsideFile }),
      )}`,
    );
    expect(res.status).toBe(401);
  });
});
