// Integration tests for the `worktree.resolvePath` tRPC query that backs
// Quick Open's "open a file by absolute path" affordance.
//
// We exercise the real server pipeline: boot the production server in a
// child process (shared `helpers/server.ts` harness — process-group teardown
// so server grandchildren don't leak), seed a worktree whose worktree is a
// real on-disk dir, then call the procedure over HTTP. The assertions pin the
// full response shape for the branches the resolver owns — a path inside the
// worktree (→ worktree-relative), a path outside it (→ external), a
// non-existent path, a directory (not a regular file), and the unauthenticated
// 401 gate. No mocks; the only seam is the band_token cookie the rest of the
// integration suite uses.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";

const DEFAULT_TOKEN = "worktree-resolve-path-test-token";
const REPO = "resolve-path-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");

interface ResolvePathResult {
  exists: boolean;
  isFile: boolean;
  external: boolean;
  worktreeRelativePath: string | null;
}

async function resolvePath(serverUrl: string, path: string): Promise<ResolvePathResult> {
  const res = await trpcQuery(
    serverUrl,
    "worktree.resolvePath",
    { worktreeId: WORKTREE, path },
    DEFAULT_TOKEN,
  );
  expect(res.status).toBe(200);
  return trpcData<ResolvePathResult>(res);
}

describe("tRPC — worktree.resolvePath", () => {
  let server: ServerHandle;
  let tmpHome: string;
  // The worktree is a real on-disk directory so stat() sees real files.
  let worktree: string;
  let insideDir: string;
  let insideFile: string;
  // An "outside" dir next to the worktree, modelling a path no worktree
  // would contain (e.g. a `/tmp/notes.md` a user pastes in).
  let outsideDir: string;
  let outsideFile: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-resolve-path-test-");

    worktree = realpathSync(mkdtempSync(join(tmpdir(), "band-resolve-path-worktree-")));
    insideDir = join(worktree, "src");
    mkdirSync(insideDir, { recursive: true });
    insideFile = join(insideDir, "inside.ts");
    writeFileSync(insideFile, "export const inside = 1;\n", "utf-8");

    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "band-resolve-path-outside-")));
    outsideFile = join(outsideDir, "notes.md");
    writeFileSync(outsideFile, "# notes\n", "utf-8");

    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
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

  it("resolves an absolute path INSIDE the worktree to its worktree-relative form", async () => {
    const data = await resolvePath(server.url, insideFile);
    expect(data).toEqual({
      exists: true,
      isFile: true,
      external: false,
      // POSIX-separated, relative to the worktree root.
      worktreeRelativePath: "src/inside.ts",
    });
  });

  it("resolves an absolute path OUTSIDE the worktree as external", async () => {
    const data = await resolvePath(server.url, outsideFile);
    expect(data).toEqual({
      exists: true,
      isFile: true,
      external: true,
      worktreeRelativePath: null,
    });
  });

  it("reports a non-existent absolute path as not existing (and external)", async () => {
    const data = await resolvePath(server.url, join(outsideDir, "does-not-exist.md"));
    expect(data).toEqual({
      exists: false,
      isFile: false,
      external: true,
      worktreeRelativePath: null,
    });
  });

  it("reports a directory as existing but not a regular file", async () => {
    const data = await resolvePath(server.url, insideDir);
    expect(data).toEqual({
      exists: true,
      isFile: false,
      external: false,
      worktreeRelativePath: "src",
    });
  });

  it("rejects unauthenticated callers", async () => {
    // resolvePath reports on arbitrary absolute paths, so the transport-layer
    // band_token is the only gate. Pin 401 specifically (a generic non-200
    // would also pass on a crash 500).
    const res = await fetch(
      `${server.url}/trpc/worktree.resolvePath?input=${encodeURIComponent(
        JSON.stringify({ worktreeId: WORKTREE, path: outsideFile }),
      )}`,
    );
    expect(res.status).toBe(401);
  });
});
