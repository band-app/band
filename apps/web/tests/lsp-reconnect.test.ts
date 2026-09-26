/**
 * The `/lsp` WebSocket proxy across reconnects.
 *
 * The language server a workspace uses outlives any one WebSocket: a page
 * reload, or a second editor after the first one closed, connects again to
 * the same `typescript-language-server` process. A connection that goes away
 * without closing its documents used to leave them open in that process, so
 * the next connection's `didOpen` of the same file was rejected ("Can't open
 * already open document") and every request on it failed with tsserver's
 * "No Project". The proxy now closes a connection's open documents when it
 * disconnects.
 *
 * Real server, real language server: the fixture repo's `node_modules` links
 * to the `typescript-language-server` and `typescript` this app installs,
 * which is where the LSP manager looks (`<worktree>/node_modules/.bin`).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { toWorkspaceId } from "@/dashboard";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";

const TOKEN = "lsp-reconnect-token";
const PROJECT = "lsp-reconnect-repo";
const MAIN_TS =
  "function addNumbers(a: number, b: number): number {\n  return a + b;\n}\nexport const total = addNumbers(1, 2);\n";
const APP_NODE_MODULES = join(import.meta.dirname, "..", "node_modules");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
}

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;

beforeAll(async () => {
  tmpHome = createTmpHome("band-lsp-reconnect-");
  repoPath = join(tmpHome, PROJECT);
  mkdirSync(join(repoPath, "src"), { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, ".gitignore"), "node_modules\n");
  writeFileSync(join(repoPath, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
  writeFileSync(join(repoPath, "src/main.ts"), MAIN_TS);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  mkdirSync(join(repoPath, "node_modules/.bin"), { recursive: true });
  symlinkSync(
    realpathSync(join(APP_NODE_MODULES, "typescript")),
    join(repoPath, "node_modules/typescript"),
  );
  symlinkSync(
    join(APP_NODE_MODULES, ".bin/typescript-language-server"),
    join(repoPath, "node_modules/.bin/typescript-language-server"),
  );

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, enableLSP: true });
  server = await startServer({ tmpHome });
}, 60_000);

afterAll(async () => {
  await server?.close();
});

/** A minimal LSP client over the proxy's WebSocket (JSON-RPC, no framing). */
class LspSocket {
  private nextId = 0;
  private pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { id?: number; result?: unknown };
      if (msg.id != null && this.pending.has(msg.id)) {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  static async open(cookie?: string): Promise<LspSocket> {
    const url = new URL(server.url);
    const ws = new WebSocket(
      `ws://${url.host}/lsp?workspaceId=${encodeURIComponent(toWorkspaceId(PROJECT, "main"))}&lang=typescript`,
      cookie ? { headers: { Cookie: cookie } } : {},
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new LspSocket(ws);
  }

  request(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

/** Initialize, open `src/main.ts`, and ask where `addNumbers` is defined. */
async function definitionOfAddNumbers(lsp: LspSocket) {
  const mainUri = `file://${repoPath}/src/main.ts`;
  await lsp.request("initialize", {
    processId: null,
    rootUri: `file://${repoPath}`,
    capabilities: {},
  });
  lsp.notify("initialized", {});
  lsp.notify("textDocument/didOpen", {
    textDocument: {
      uri: mainUri,
      languageId: "typescript",
      version: 0,
      text: MAIN_TS,
    },
  });
  // `addNumbers` in `export const total = addNumbers(1, 2);` (line 3, col 21).
  return await lsp.request("textDocument/definition", {
    textDocument: { uri: mainUri },
    position: { line: 3, character: 21 },
  });
}

describe("/lsp proxy reconnects", () => {
  it("rejects a connection without the auth cookie", async () => {
    await expect(LspSocket.open()).rejects.toThrow();
  });

  it("answers go-to-definition on a file a previous, disconnected client had open", async () => {
    // The function's name on line 0.
    const definition = {
      uri: `file://${repoPath}/src/main.ts`,
      range: { start: { line: 0, character: 9 }, end: { line: 0, character: 19 } },
    };

    const first = await LspSocket.open(`band_token=${TOKEN}`);
    const firstResponse = await definitionOfAddNumbers(first);
    expect(firstResponse.error).toBeUndefined();
    expect(firstResponse.result).toEqual([definition]);
    // Disconnect without closing the document, as a page reload does.
    await first.close();

    const second = await LspSocket.open(`band_token=${TOKEN}`);
    const secondResponse = await definitionOfAddNumbers(second);
    expect(secondResponse.error).toBeUndefined();
    expect(secondResponse.result).toEqual([definition]);
    await second.close();
  }, 60_000);
});
