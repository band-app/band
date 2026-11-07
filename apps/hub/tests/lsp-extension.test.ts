/**
 * Language servers come from extensions. A real hub and a real `band-worker`; the TypeScript
 * server is a stand-in `typescript-lsp` extension (`helpers/lsp-extension.ts`).
 *
 *  - With no extension installed, the worker offers no language server and a socket for one is
 *    refused, and the hub and worker builds hold no typescript-language-server.
 *  - A server whose `requires` is missing is reported as "needs <binary>".
 *  - A server with root markers is refused in a worktree that has none.
 *  - A restricted worker runs none.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createTsLspRepo } from "./fixtures/ts-lsp-repo";
import {
  installTsLsp,
  languageServers,
  TS_LSP_KEY,
  waitForLanguageServer,
} from "./helpers/lsp-extension";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";
import { LOOPBACK_HOST_ID } from "./helpers/test-host";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "lsp-extension-token";
const REPO = "lsp-extension-repo";
const BARE = "lsp-extension-bare";
const WORKTREE = toWorktreeId(REPO, "main", LOOPBACK_HOST_ID);
const BARE_WORKTREE = toWorktreeId(BARE, "main", LOOPBACK_HOST_ID);

let server: ServerHandle;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = createTmpHome("band-lsp-extension-");
  const repoPath = join(tmpHome, REPO);
  createTsLspRepo({
    repoPath,
    branch: "main",
    committed: { "src/main.ts": "export const a = 1;\n" },
  });
  // A worktree with none of the TypeScript root markers.
  const barePath = join(tmpHome, BARE);
  createTsLspRepo({ repoPath: barePath, branch: "main", committed: { "main.ts": "export {};\n" } });
  rmSync(join(barePath, "tsconfig.json"));
  seedState(tmpHome, {
    repos: [REPO, BARE].map((name) => ({
      name,
      path: join(tmpHome, name),
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: join(tmpHome, name) }],
    })),
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, enableLSP: true });
  server = await startServer({ tmpHome, remoteHost: true });
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Opens the socket and resolves with how the server closed it, or "open" if it stayed up. */
async function closeOf(
  worktreeId: string,
  lang: string,
): Promise<{ code: number; reason: string }> {
  const url = new URL(server.url);
  const ws = new WebSocket(
    `ws://${url.host}/lsp?worktreeId=${encodeURIComponent(worktreeId)}&lang=${encodeURIComponent(lang)}`,
    { headers: { Cookie: `band_token=${TOKEN}` } },
  );
  return new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.once("open", () => {
      // The server accepts the upgrade first and refuses when it cannot start the language server.
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shutdown" }));
      setTimeout(() => {
        ws.close();
      }, 5_000);
    });
  });
}

describe("language servers from extensions", () => {
  it("offers none and refuses a socket while no extension is installed (S1)", async () => {
    expect(await languageServers(server.url, TOKEN, LOOPBACK_HOST_ID)).toEqual([]);
    const closed = await closeOf(WORKTREE, TS_LSP_KEY);
    expect(closed.code).toBe(4001);
    expect(closed.reason).toMatch(/No language server configured/);
    for (const dist of ["dist", "../worker/dist"]) {
      expect(
        existsSync(
          join(import.meta.dirname, "..", dist, "node_modules/typescript-language-server"),
        ),
      ).toBe(false);
    }
  });

  it("reports a server whose binary is missing as needing it, and starts nothing (S4)", async () => {
    await installTsLsp(server.url, TOKEN, { requires: ["definitely-not-a-binary"] });
    const state = await waitForLanguageServer(server.url, TOKEN, LOOPBACK_HOST_ID, "unavailable");
    expect(state.reason).toBe("needs definitely-not-a-binary");
    const closed = await closeOf(WORKTREE, TS_LSP_KEY);
    expect(closed.code).toBe(4001);
    expect(closed.reason).toMatch(/needs definitely-not-a-binary/);
  });

  it("serves a worktree with a root marker and refuses one without", async () => {
    await installTsLsp(server.url, TOKEN, { version: "1.0.1" });
    await waitForLanguageServer(server.url, TOKEN, LOOPBACK_HOST_ID, "ready");
    const closed = await closeOf(BARE_WORKTREE, TS_LSP_KEY);
    expect(closed.code).toBe(4001);
    expect(closed.reason).toMatch(/No project/);
    mkdirSync(join(tmpHome, BARE), { recursive: true });
    writeFileSync(join(tmpHome, BARE, "package.json"), "{}\n");
    const ok = await closeOf(BARE_WORKTREE, TS_LSP_KEY);
    // The server stays up until the test's own timer closes the socket.
    expect(ok.code).not.toBe(4001);
  }, 60_000);

  it("runs none on a restricted worker (S4)", async () => {
    const res = await trpcMutate(
      server.url,
      "hosts.setTrust",
      { hostId: LOOPBACK_HOST_ID, trust: "restricted" },
      TOKEN,
    );
    expect(res.status).toBe(200);
    await waitFor(
      async () =>
        (await languageServers(server.url, TOKEN, LOOPBACK_HOST_ID)).length === 0
          ? true
          : undefined,
      { label: "no language servers on a restricted worker", timeoutMs: 20_000, intervalMs: 200 },
    );
    // The worker may still be applying the trust drop. A server it already ran is killed then,
    // so the socket is refused once the drop has landed.
    const closed = await waitFor(
      async () => {
        const result = await closeOf(WORKTREE, TS_LSP_KEY);
        return result.code === 4001 ? result : undefined;
      },
      {
        label: "a restricted worker refusing the language server",
        timeoutMs: 40_000,
        intervalMs: 500,
      },
    );
    expect(closed.code).toBe(4001);
  }, 60_000);
});
