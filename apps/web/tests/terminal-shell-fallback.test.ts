// Integration test for the cross-platform shell fallback (issue #594,
// Linux standalone). Black-box against the production server bundle
// (`dist/start-server.mjs`) with a real terminal WebSocket client. No mocks.
//
// Regression guard: the terminal pool used to hardcode
// `process.env.SHELL || "/bin/zsh"`. On a stock Linux host with no `$SHELL`
// and no zsh installed, that resolved to `/bin/zsh`, failed the
// `existsSync(shell)` guard, and the PTY never spawned — the WS handler
// emitted a `{type:"error", message:"Shell not found: /bin/zsh"}` frame and
// closed. `defaultShell()` now probes `/bin/zsh` → `/bin/bash` → `/bin/sh`,
// so a terminal still spawns when `$SHELL` is unset.
//
// We reproduce the "no $SHELL" host by deleting `SHELL` from the parent env
// BEFORE the server boots, so the spawned server inherits an environment
// with no `SHELL` — exactly the stock-service case. `fileParallelism` is
// off (see vitest.config.ts) so no other suite runs while `SHELL` is
// removed, and we restore it as soon as the child has been spawned.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";

const TOKEN = "terminal-shell-fallback-token";

describe("terminal spawns with no $SHELL set (shell fallback)", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-terminal-shell-fallback-");
    const projectPath = join(tmpHome, "workspace");
    mkdirSync(projectPath, { recursive: true });
    seedState(tmpHome, {
      projects: [
        {
          name: "workspace",
          path: projectPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: projectPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });

    const savedShell = process.env.SHELL;
    delete process.env.SHELL;
    try {
      server = await startServer({ tmpHome });
    } finally {
      // The child already inherited the SHELL-less env at spawn time, so
      // restore the parent's value immediately.
      if (savedShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = savedShell;
    }
  });

  afterAll(async () => {
    if (server) await server.close();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("attaches a live PTY and streams output instead of a shell-not-found error", async () => {
    const port = new URL(server.url).port;
    const workspaceId = "workspace-main";
    const terminalId = "shell-fallback-terminal";
    const wsUrl = `ws://127.0.0.1:${port}/terminal?workspaceId=${workspaceId}&terminalId=${terminalId}`;

    const ws = new WebSocket(wsUrl, { headers: { Cookie: `band_token=${TOKEN}` } });

    let sawOutput = false;
    let errorFrame: string | undefined;

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "init" })));
      // The first server frame decides the outcome: a spawn failure sends a
      // JSON `{type:"error"}` frame; a successful spawn streams scrollback /
      // the shell prompt (binary or text). Either way we resolve on the
      // first frame.
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          try {
            const parsed = JSON.parse(data.toString()) as { type?: string; message?: string };
            if (parsed.type === "error") {
              errorFrame = parsed.message;
              resolve();
              return;
            }
          } catch {
            // Non-JSON text frame — that's PTY output.
          }
        }
        sawOutput = true;
        resolve();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("No terminal frame within 10 s")), 10_000);
    });

    ws.close();

    expect(errorFrame, `unexpected error frame: ${errorFrame}`).toBeUndefined();
    expect(sawOutput).toBe(true);
  });

  it("rejects the terminal WebSocket upgrade without an auth token", async () => {
    const port = new URL(server.url).port;
    const wsUrl = `ws://127.0.0.1:${port}/terminal?workspaceId=workspace-main&terminalId=noauth-terminal`;

    // No `Cookie` header — the upgrade must be destroyed before a PTY is
    // ever attached, so the socket never reaches the "open" state.
    const ws = new WebSocket(wsUrl);
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
      ws.on("close", () => resolve("closed"));
      setTimeout(() => resolve("timeout"), 3000);
    });
    ws.close();

    expect(outcome).not.toBe("open");
  });
});
