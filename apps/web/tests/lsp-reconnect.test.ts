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

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { toWorkspaceId } from "@/dashboard";
import { createTsLspRepo } from "./fixtures/ts-lsp-repo";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";

const TOKEN = "lsp-reconnect-token";
const PROJECT = "lsp-reconnect-repo";
const MAIN_TS =
  "function addNumbers(a: number, b: number): number {\n  return a + b;\n}\nexport const total = addNumbers(1, 2);\n";
const REQUEST_TIMEOUT_MS = 20_000;

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;

beforeAll(async () => {
  tmpHome = createTmpHome("band-lsp-reconnect-");
  repoPath = join(tmpHome, PROJECT);
  createTsLspRepo({ repoPath, branch: "main", committed: { "src/main.ts": MAIN_TS } });

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
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

/** A minimal LSP client over the proxy's WebSocket (JSON-RPC, no framing). */
class LspSocket {
  private nextId: number;
  private pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();

  private constructor(
    private readonly ws: WebSocket,
    idBase: number,
  ) {
    this.nextId = idBase;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { id?: number; method?: string };
      // Responses only: a server-to-client request also carries an `id`.
      if (msg.method === undefined && msg.id != null && this.pending.has(msg.id)) {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  /** `idBase` keeps two live sockets' request ids apart: the proxy forwards
   *  every server message to every connection on the language server. */
  static async open(cookie?: string, idBase = 0): Promise<LspSocket> {
    const url = new URL(server.url);
    const ws = new WebSocket(
      `ws://${url.host}/lsp?workspaceId=${encodeURIComponent(toWorkspaceId(PROJECT, "main"))}&lang=typescript`,
      cookie ? { headers: { Cookie: cookie } } : {},
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new LspSocket(ws, idBase);
  }

  request(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no response to ${method} within ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
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
    // The upgrade handler destroys an unauthenticated socket before replying.
    await expect(LspSocket.open()).rejects.toThrow(/socket hang up/);
    await expect(LspSocket.open("band_token=wrong-token")).rejects.toThrow(/socket hang up/);
  });

  // The function's name on line 0.
  const definition = () => ({
    uri: `file://${repoPath}/src/main.ts`,
    range: { start: { line: 0, character: 9 }, end: { line: 0, character: 19 } },
  });

  it("answers go-to-definition on a file a previous, disconnected client had open", async () => {
    const first = await LspSocket.open(`band_token=${TOKEN}`);
    const firstResponse = await definitionOfAddNumbers(first);
    expect(firstResponse.error).toBeUndefined();
    expect(firstResponse.result).toEqual([definition()]);
    // Disconnect without closing the document, as a page reload does.
    await first.close();

    const second = await LspSocket.open(`band_token=${TOKEN}`);
    const secondResponse = await definitionOfAddNumbers(second);
    expect(secondResponse.error).toBeUndefined();
    expect(secondResponse.result).toEqual([definition()]);
    await second.close();
  }, 60_000);

  it("keeps a file open for a client while another client that had it open disconnects", async () => {
    // Two tabs on one workspace share the language server.
    const leaving = await LspSocket.open(`band_token=${TOKEN}`);
    const staying = await LspSocket.open(`band_token=${TOKEN}`, 1_000);
    expect((await definitionOfAddNumbers(leaving)).result).toEqual([definition()]);
    expect((await definitionOfAddNumbers(staying)).result).toEqual([definition()]);

    await leaving.close();

    // The client's close event does not order the proxy's disconnect handling
    // before the next request, so keep asking over a window long enough for
    // a `didClose` from the disconnect to have reached the server.
    const start = Date.now();
    while (Date.now() - start < 1_500) {
      const response = await staying.request("textDocument/definition", {
        textDocument: { uri: `file://${repoPath}/src/main.ts` },
        position: { line: 3, character: 21 },
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual([definition()]);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await staying.close();
  }, 60_000);
});
