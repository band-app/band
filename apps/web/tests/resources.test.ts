/**
 * Backend integration test for the Resources dashboard (issue #506).
 *
 * Boots the real production server bundle against a fresh tmp HOME,
 * seeds a real git repo + worktree, and calls the three tRPC
 * procedures (`services.resourcesServer`, `services.resourcesProjects`,
 * `services.resourcesProjectSize`) over HTTP. No mocking — the test
 * exercises the same code path the dashboard hits in production.
 *
 * Per `CLAUDE.md`, `apps/web` is the one package in the repo that
 * standardised on vitest before the node:test convention was written
 * down, so we follow the existing vitest convention here.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const TOKEN = "test-token-resources";
const PROJECT = "resources-fixture";
const BRANCH = "main";
const SEED_FILE_BYTES = 1024 * 1024; // 1 MiB

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  // `mkdtempSync` on macOS returns a path under `/var/folders/...`
  // but the OS canonical form is `/private/var/folders/...`. `git`
  // and `du` will follow that symlink and report the canonical
  // path, which then mismatches our assertions. Canonicalise at
  // construction so the seed path matches what subprocesses see.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-test-resources-")));
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
      if (chunk.toString().includes("listening") && !settled) {
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
        reject(new Error(`Server exited with code ${code}.\nstderr: ${stderr}`));
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

async function trpcQuery(
  url: string,
  procedure: string,
  token: string,
  input?: unknown,
): Promise<Response> {
  const suffix = input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : "";
  return fetch(`${url}/trpc/${procedure}${suffix}`, {
    headers: { Cookie: `band_token=${token}` },
  });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

describe("services.resourcesServer + resourcesProjects + resourcesProjectSize (issue #506)", () => {
  // Definite-assignment in `beforeAll`. The `typeof` guard in
  // `afterAll` covers the only path that could leave it
  // unassigned: `startServer` throwing before resolving. Without
  // the guard, an unrelated `TypeError: Cannot read properties of
  // undefined (reading 'close')` would mask the real boot failure.
  let server!: ServerHandle;
  let tmpHome: string;
  let projectPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Real git repo with a known-size seed file. The server walks
    // this directory at request time — no fixtures-on-disk shortcut.
    projectPath = join(tmpHome, PROJECT);
    mkdirSync(projectPath, { recursive: true });
    execFileSync("git", ["init", "-q", "--initial-branch", BRANCH], {
      cwd: projectPath,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: projectPath,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], {
      cwd: projectPath,
      stdio: "ignore",
    });
    writeFileSync(join(projectPath, "seed.bin"), Buffer.alloc(SEED_FILE_BYTES));
    execFileSync("git", ["add", "."], { cwd: projectPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "seed"], {
      cwd: projectPath,
      stdio: "ignore",
    });

    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: projectPath,
          defaultBranch: BRANCH,
          worktrees: [{ branch: BRANCH, path: projectPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    if (typeof server !== "undefined") await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("resourcesServer returns a process snapshot with positive pid + memory", async () => {
    const res = await trpcQuery(server.url, "services.resourcesServer", TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      pid: number;
      uptimeSeconds: number;
      nodeVersion: string;
      platform: string;
      arch: string;
      memory: {
        rssBytes: number;
        heapTotalBytes: number;
        heapUsedBytes: number;
        externalBytes: number;
        arrayBuffersBytes: number;
      };
      cpu: { userMicros: number; systemMicros: number };
    }>(res);

    expect(data.pid).toBeGreaterThan(0);
    expect(data.uptimeSeconds).toBeGreaterThan(0);
    expect(data.nodeVersion).toMatch(/^v\d+\./);
    expect(typeof data.platform).toBe("string");
    expect(data.memory.rssBytes).toBeGreaterThan(0);
    expect(data.memory.heapTotalBytes).toBeGreaterThan(0);
    expect(data.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(data.cpu.userMicros).toBeGreaterThanOrEqual(0);
    expect(data.cpu.systemMicros).toBeGreaterThanOrEqual(0);
  });

  it("resourcesProjects returns the seeded project + worktree paths without doing disk walks", async () => {
    const res = await trpcQuery(server.url, "services.resourcesProjects", TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      projects: Array<{
        project: string;
        path: string;
        worktrees: Array<{ branch: string; path: string }>;
        error?: string;
      }>;
    }>(res);

    expect(data.projects.length).toBeGreaterThanOrEqual(1);
    const proj = data.projects.find((p) => p.project === PROJECT);
    expect(proj).toBeDefined();
    expect(proj?.error).toBeUndefined();
    expect(proj?.worktrees.length).toBe(1);
    const wt = proj?.worktrees[0];
    expect(wt?.branch).toBe(BRANCH);
    // `git worktree list --porcelain` returns the canonical (realpath)
    // path; macOS tmp dirs are symlinks (`/var/...` → `/private/var/...`).
    expect(wt?.path).toBe(realpathSync(projectPath));
  });

  it("resourcesProjectSize returns the seeded project's worktree sizes >= seed file size", async () => {
    const res = await trpcQuery(server.url, "services.resourcesProjectSize", TOKEN, {
      project: PROJECT,
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      project: string;
      sizeBytes: number;
      worktrees: Array<{
        branch: string;
        path: string;
        sizeBytes: number;
        error?: string;
      }>;
      error?: string;
    }>(res);

    expect(data.project).toBe(PROJECT);
    expect(data.error).toBeUndefined();
    expect(data.worktrees.length).toBe(1);
    const wt = data.worktrees[0];
    expect(wt.branch).toBe(BRANCH);
    expect(wt.error).toBeUndefined();
    expect(wt.path).toBe(realpathSync(projectPath));
    // Walk must include the 1 MiB seed file plus git plumbing (.git
    // objects, index, etc.) — strictly greater is the safest lower
    // bound that's still a real assertion.
    expect(wt.sizeBytes).toBeGreaterThanOrEqual(SEED_FILE_BYTES);

    // Project total must equal the sum of its worktree sizes.
    const expectedTotal = data.worktrees.reduce((sum, w) => sum + w.sizeBytes, 0);
    expect(data.sizeBytes).toBe(expectedTotal);
  });

  it("resourcesProjectSize returns NOT_FOUND for an unknown project", async () => {
    const res = await trpcQuery(server.url, "services.resourcesProjectSize", TOKEN, {
      project: "this-project-does-not-exist",
    });
    expect(res.status).toBe(404);
  });

  // The Resources surface returns process internals (PID, memory,
  // worktree paths). Lock in the contract that all three procedures
  // reject unauthenticated requests when the server has a token
  // configured — a regression here would leak data to anyone who
  // can reach the port.
  it("rejects unauthenticated requests on every resources procedure", async () => {
    const serverRes = await fetch(`${server.url}/trpc/services.resourcesServer`);
    expect(serverRes.status).toBe(401);

    const projectsRes = await fetch(`${server.url}/trpc/services.resourcesProjects`);
    expect(projectsRes.status).toBe(401);

    const sizeRes = await fetch(
      `${server.url}/trpc/services.resourcesProjectSize?input=${encodeURIComponent(
        JSON.stringify({ project: PROJECT }),
      )}`,
    );
    expect(sizeRes.status).toBe(401);
  });
});
