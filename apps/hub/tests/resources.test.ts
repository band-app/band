/**
 * Backend integration test for the Resources dashboard (issue #506).
 *
 * Boots the real production server bundle against a fresh tmp HOME,
 * seeds a real git repo + worktree, and calls the three tRPC
 * procedures (`services.resourcesServer`, `services.resourcesRepos`,
 * `services.resourcesRepoSize`) over HTTP. No mocking — the test
 * exercises the same code path the dashboard hits in production.
 *
 * This package uses vitest.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome as createCanonicalTmpHome,
  type ServerHandle,
  startServer as startCanonicalServer,
} from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";

const TOKEN = "test-token-resources";
const REPO = "resources-fixture";
const BRANCH = "main";
const SEED_FILE_BYTES = 1024 * 1024; // 1 MiB

function createTmpHome(): string {
  return createCanonicalTmpHome("band-test-resources-");
}

function startServer(opts: { tmpHome: string }): Promise<ServerHandle> {
  return startCanonicalServer({ tmpHome: opts.tmpHome, remoteHost: false });
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

describe("services.resourcesServer + resourcesRepos + resourcesRepoSize (issue #506)", () => {
  // Definite-assignment in `beforeAll`. The `typeof` guard in
  // `afterAll` covers the only path that could leave it
  // unassigned: `startServer` throwing before resolving. Without
  // the guard, an unrelated `TypeError: Cannot read properties of
  // undefined (reading 'close')` would mask the real boot failure.
  let server!: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Real git repo with a known-size seed file. The server walks
    // this directory at request time — no fixtures-on-disk shortcut.
    repoPath = join(tmpHome, REPO);
    mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init", "-q", "--initial-branch", BRANCH], {
      cwd: repoPath,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repoPath,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], {
      cwd: repoPath,
      stdio: "ignore",
    });
    writeFileSync(join(repoPath, "seed.bin"), Buffer.alloc(SEED_FILE_BYTES));
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "seed"], {
      cwd: repoPath,
      stdio: "ignore",
    });

    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: repoPath,
          defaultBranch: BRANCH,
          worktrees: [{ branch: BRANCH, path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    if (typeof server !== "undefined") await server.close();
    removeTmpHome(tmpHome);
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

  it("resourcesRepos returns the seeded repo + worktree paths without doing disk walks", async () => {
    const res = await trpcQuery(server.url, "services.resourcesRepos", TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      repos: Array<{
        repo: string;
        path: string;
        worktrees: Array<{ branch: string; path: string }>;
        error?: string;
      }>;
    }>(res);

    expect(data.repos.length).toBeGreaterThanOrEqual(1);
    const proj = data.repos.find((p) => p.repo === REPO);
    expect(proj).toBeDefined();
    expect(proj?.error).toBeUndefined();
    expect(proj?.worktrees.length).toBe(1);
    const wt = proj?.worktrees[0];
    expect(wt?.branch).toBe(BRANCH);
    // `git worktree list --porcelain` returns the canonical (realpath)
    // path; macOS tmp dirs are symlinks (`/var/...` → `/private/var/...`).
    expect(wt?.path).toBe(realpathSync(repoPath));
  });

  it("resourcesRepoSize returns the seeded repo's worktree sizes >= seed file size", async () => {
    const res = await trpcQuery(server.url, "services.resourcesRepoSize", TOKEN, {
      repo: REPO,
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      repo: string;
      sizeBytes: number;
      worktrees: Array<{
        branch: string;
        path: string;
        sizeBytes: number;
        error?: string;
      }>;
      error?: string;
    }>(res);

    expect(data.repo).toBe(REPO);
    expect(data.error).toBeUndefined();
    expect(data.worktrees.length).toBe(1);
    const wt = data.worktrees[0];
    expect(wt.branch).toBe(BRANCH);
    expect(wt.error).toBeUndefined();
    expect(wt.path).toBe(realpathSync(repoPath));
    // Walk must include the 1 MiB seed file plus git plumbing (.git
    // objects, index, etc.) — strictly greater is the safest lower
    // bound that's still a real assertion.
    expect(wt.sizeBytes).toBeGreaterThanOrEqual(SEED_FILE_BYTES);

    // Repo total must equal the sum of its worktree sizes.
    const expectedTotal = data.worktrees.reduce((sum, w) => sum + w.sizeBytes, 0);
    expect(data.sizeBytes).toBe(expectedTotal);
  });

  it("resourcesRepoSize returns NOT_FOUND for an unknown repo", async () => {
    const res = await trpcQuery(server.url, "services.resourcesRepoSize", TOKEN, {
      repo: "this-repo-does-not-exist",
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

    const reposRes = await fetch(`${server.url}/trpc/services.resourcesRepos`);
    expect(reposRes.status).toBe(401);

    const sizeRes = await fetch(
      `${server.url}/trpc/services.resourcesRepoSize?input=${encodeURIComponent(
        JSON.stringify({ repo: REPO }),
      )}`,
    );
    expect(sizeRes.status).toBe(401);
  });
});
