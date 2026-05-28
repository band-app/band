// Shared server-boot helpers for vitest integration tests. Spawns the
// real production web server (`dist/start-server.mjs`) on a random
// port against a fresh tmp `$HOME`, the same shape every existing
// integration test under `apps/web/tests/` uses inline.
//
// History: the helpers were inlined in `trpc.test.ts`,
// `task-cleanup.test.ts`, `trpc-batch-url.test.ts`, and (initially)
// `workspace-remove-detached.test.ts` — four copies that had already
// drifted (the SIGKILL fallback below lived only in
// `task-cleanup.test.ts`). This module is the canonical version; new
// tests should import from here. The pre-existing tests are not
// migrated in this PR to keep its diff focused on the
// detached-HEAD bug fix.
//
// TODO: migrate `trpc.test.ts`, `task-cleanup.test.ts`, and
// `trpc-batch-url.test.ts` to import from this module instead of
// inlining their own copies of `createTmpHome` / `getRandomPort` /
// `startServer` / `trpcMutate`. The longer those copies live, the
// more they will drift from this one — and the SIGKILL fallback +
// the `trpcMutate` shape are improvements that should reach the
// older tests too. Tracked as a follow-up rather than done here so
// this PR stays scoped to the detached-HEAD bug.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");

export interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

/**
 * Create a fresh tmp `$HOME` with `.band/` pre-created. Resolves
 * symlinks (macOS `/var` → `/private/var`) so paths match what the
 * server records.
 */
export function createTmpHome(prefix: string): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(tmp, ".band"), { recursive: true });
  return tmp;
}

/**
 * Ask the kernel for a free TCP port, then immediately close the
 * probe socket so the test server can bind to it. Subject to the
 * usual race-window — but every existing inline copy used the same
 * approach and the failure mode (port reused before bind) hasn't
 * surfaced in practice.
 */
export function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * POST a tRPC mutation against a running test server and return the
 * raw `Response`. Caller is responsible for status / body assertions
 * — leaving the JSON parsing to the caller keeps the helper neutral
 * about whether a test wants to assert on a successful response
 * shape or on an error body. Auth is via the `band_token` cookie;
 * pass the same token the test passed to `seedSettings`.
 *
 * `input` is treated as the procedure input. Both `undefined` and
 * `null` are treated as "no input" — `JSON.stringify(null)` would
 * otherwise send the literal string `"null"`, which the tRPC server
 * rejects with a parse error.
 */
export function trpcMutate(
  serverUrl: string,
  procedure: string,
  input: unknown,
  token: string,
): Promise<Response> {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `band_token=${token}`,
    },
    body: input != null ? JSON.stringify(input) : "{}",
  });
}

/**
 * GET a tRPC query against a running test server and return the raw
 * `Response`. Mirrors `trpcMutate` — leaves status / body assertions to
 * the caller. Auth is via the `band_token` cookie; pass the same token
 * the test passed to `seedSettings`.
 *
 * `input` is URL-encoded into the standard tRPC GET shape
 * (`?input=<json>`) when provided, omitted otherwise.
 *
 * Production clients use the `httpBatchLink` (`?batch=1&input=...`) but
 * the un-batched GET path is also accepted by the server and is the
 * convention every existing inline-helper test in this folder uses, so
 * the helper exposes the same shape to keep new tests symmetric with
 * the old ones rather than mixing GET shapes within the suite.
 */
export function trpcQuery(
  serverUrl: string,
  procedure: string,
  input: unknown,
  token: string,
): Promise<Response> {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: { Cookie: `band_token=${token}` } });
}

/**
 * Parse a tRPC success response into its typed `result.data` payload.
 *
 * Sugar so test bodies don't have to repeat the `body.result.data` cast
 * after every `trpcQuery` / `trpcMutate` call. Use only on successful
 * responses — error bodies do not match this shape, and callers should
 * assert `res.status` first.
 */
export async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

export interface StartServerOptions {
  tmpHome: string;
  env?: Record<string, string>;
}

/**
 * Boot the production server bundle in a child process. Resolves
 * when the server logs `"listening"` to stdout; rejects if it exits
 * first or doesn't bind within 15 s. The returned `close()` sends
 * `SIGTERM` and falls back to `SIGKILL` after 5 s so a server stuck
 * in a DB lock can't hang `afterAll` indefinitely.
 */
export async function startServer(opts: StartServerOptions): Promise<ServerHandle> {
  const { tmpHome, env: extraEnv } = opts;
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: tmpHome,
        PORT: String(port),
        NODE_ENV: "production",
        ...extraEnv,
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
          home: tmpHome,
          close: () =>
            new Promise<void>((r) => {
              const fallback = setTimeout(() => child.kill("SIGKILL"), 5_000);
              child.on("exit", () => {
                clearTimeout(fallback);
                r();
              });
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
        reject(new Error(`server exited with code ${code} before listening\nstderr: ${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`server did not start within 15 s\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}
