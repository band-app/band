// Integration test for the terminal WebSocket handler.
//
// Reproduces the crash reported in production: a stale worktree path
// triggers `Workspace directory does not exist: <long path>` in the
// terminal pool, which the WS handler tried to pass to `ws.close(code,
// reason)`. RFC 6455 caps close reasons at 123 bytes, and `ws` throws an
// async `RangeError` over the limit — bubbling up as an Unhandled
// Rejection that crashed the server.
//
// This test asserts the production fix
// (apps/web/src/server/api/terminals/ws.ts):
//   1. The full error is delivered as a JSON `{type:"error"}` frame so the
//      client still sees the real message.
//   2. The close frame carries code 4001 with a clamped reason ≤123 UTF-8
//      bytes.
//   3. The server process stays alive — a follow-up HTTP request still
//      returns successfully (the regression killed the entire web server).
//
// Per CLAUDE.md, this is a black-box integration test against the
// production server bundle (`dist/start-server.mjs`), with a real
// WebSocket client. No mocks.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "terminal-ws-test-token";

// A deliberately long, nonexistent worktree path. The terminal pool
// throws `Workspace directory does not exist: ${cwd}` (36 + cwd bytes), so
// any cwd longer than 87 bytes will overrun the 123-byte close-reason
// limit. The path below is 117 bytes — message total ≈ 153 bytes, well
// over the cap.
function makeLongStalePath(home: string): string {
  return join(
    home,
    "Clients",
    "journoo",
    "journoo-ai",
    "journoo_app",
    ".claude",
    "worktrees",
    "feat-journaling-promptkey-very-long-branch-name-for-padding",
  );
}

interface ServerHandle {
  url: string;
  port: number;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-terminal-ws-test-")));
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

async function startServer(
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<ServerHandle> {
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
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
      const text = chunk.toString();
      if (text.includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          port,
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

describe("terminal WebSocket — close-reason byte cap", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let stalePath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    stalePath = makeLongStalePath(tmpHome);

    // Sanity check: the message we expect the handler to emit must exceed
    // the 123-byte cap, otherwise the test would pass with the bug in
    // place. If this throws, bump the path length above.
    const expectedMsg = `Workspace directory does not exist: ${stalePath}`;
    if (Buffer.byteLength(expectedMsg, "utf8") <= 123) {
      throw new Error(
        `Test fixture broken: expected message is only ${Buffer.byteLength(
          expectedMsg,
          "utf8",
        )} bytes — must exceed 123 to exercise the regression.`,
      );
    }

    // Seed a project with a worktree pointing at a path that DOES NOT exist
    // on disk. TerminalPool.spawn will throw the long error
    // message when the WS handler tries to spawn into this workspace.
    seedState(tmpHome, {
      projects: [
        {
          name: "journoo_app",
          path: join(tmpHome, "Clients", "journoo", "journoo-ai", "journoo_app"),
          defaultBranch: "main",
          worktrees: [{ branch: "feat-journaling-promptkey", path: stalePath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });

    server = await startServer(tmpHome);
  });

  afterAll(async () => {
    if (server) await server.close();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("clamps close reason to ≤123 bytes and ships the full message in a JSON frame", async () => {
    const workspaceId = "journoo_app-feat-journaling-promptkey";
    const terminalId = "test-terminal-1";
    const wsUrl = `ws://127.0.0.1:${server.port}/terminal?workspaceId=${workspaceId}&terminalId=${terminalId}`;

    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: `band_token=${DEFAULT_TOKEN}` },
    });

    interface Outcome {
      jsonError?: { type: string; message: string };
      closeCode?: number;
      closeReason?: Buffer;
    }
    const outcome: Outcome = {};

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "init" }));
      });
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === "error") outcome.jsonError = parsed;
        } catch {
          // ignore non-JSON frames
        }
      });
      ws.on("close", (code: number, reason: Buffer) => {
        outcome.closeCode = code;
        outcome.closeReason = reason;
        resolve();
      });
      ws.on("error", (err) => {
        // The bug manifested as an *uncaught* server-side RangeError that
        // surfaced on the client as an abrupt socket close, NOT a clean
        // close frame. We want the client to see a normal close — so any
        // socket-level error means the fix isn't working.
        reject(err);
      });
      setTimeout(() => reject(new Error("WebSocket did not close within 10 s")), 10_000);
    });

    // 1. Full error message arrived as a JSON frame BEFORE the close.
    expect(outcome.jsonError).toBeDefined();
    expect(outcome.jsonError!.message).toContain("Workspace directory does not exist");
    expect(outcome.jsonError!.message).toContain(stalePath);

    // 2. Close frame uses the handler's app-level code and a clamped reason.
    expect(outcome.closeCode).toBe(4001);
    expect(outcome.closeReason).toBeDefined();
    expect(outcome.closeReason!.byteLength).toBeLessThanOrEqual(123);
    // The clamped reason should still be a prefix of the real message so
    // it's debuggable from network logs without needing the JSON frame.
    expect(outcome.closeReason!.toString("utf8")).toMatch(/^Workspace directory does not exist:/);

    // 3. The server is still alive — the regression was an unhandled
    //    rejection that killed the entire process. Any HTTP response
    //    (including 4xx) proves the listener is still up; if the server
    //    had died, fetch() would reject with ECONNREFUSED. We pin to a
    //    sub-500 status to catch the case where the bug morphs into a
    //    500 from leaked internal state.
    const healthRes = await fetch(`${server.url}/`, {
      headers: { Cookie: `band_token=${DEFAULT_TOKEN}` },
    });
    expect(healthRes.status).toBeLessThan(500);
  });
});

describe("terminal WebSocket — application-level ping/pong heartbeat", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    // A real, existing worktree directory so the PTY actually spawns — the
    // ping/pong path only runs once a session is attached.
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
      tokenSecret: DEFAULT_TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });
    server = await startServer(tmpHome);
  });

  afterAll(async () => {
    if (server) await server.close();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("responds with a {type:'pong'} frame to a client {type:'ping'}", async () => {
    const workspaceId = "workspace-main";
    const terminalId = "ping-pong-terminal";
    const wsUrl = `ws://127.0.0.1:${server.port}/terminal?workspaceId=${workspaceId}&terminalId=${terminalId}`;

    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: `band_token=${DEFAULT_TOKEN}` },
    });

    let gotPong = false;
    let pinged = false;

    await new Promise<void>((resolve, reject) => {
      // Spawn the PTY. The `init` message is consumed by the handler's
      // one-shot listener; the persistent `message` listener (which serves
      // ping/pong) is only attached after the async spawn resolves, so we
      // must wait for the first server frame before pinging — otherwise the
      // ping races ahead of the listener and is dropped.
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "init" }));
      });
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!pinged) {
          // First frame (PTY scrollback / shell prompt) proves the session is
          // attached and the message listener is live — now ping.
          pinged = true;
          ws.send(JSON.stringify({ type: "ping" }));
          return;
        }
        if (isBinary) return; // further PTY output frames
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === "pong") {
            gotPong = true;
            resolve();
          }
        } catch {
          // ignore non-JSON frames
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("No pong received within 10 s")), 10_000);
    });

    expect(gotPong).toBe(true);
    ws.close();
  });
});

describe("terminal WebSocket — OSC color-query stripping on scrollback replay", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
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
      tokenSecret: DEFAULT_TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });
    // Pin the shell so `printf`'s octal-escape handling is deterministic
    // across macOS (defaults to zsh) and Linux CI. bash exists on both.
    server = await startServer(tmpHome, { SHELL: "/bin/bash" });
  });

  afterAll(async () => {
    if (server) await server.close();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  // Regression for band-app/band#613: a stale OSC 10/11/12 color query sitting
  // in scrollback used to survive replay (stripTerminalQueries only matched CSI
  // sequences). The client's xterm.js then answered the replayed query, the
  // dashboard forwarded the answer to the PTY, and the shell's line editor
  // inserted the printable remainder (`11;rgb:1e1e/1e1e/1e1e…`) as literal text
  // at the prompt. This test proves the OSC bytes are stripped from replayed
  // scrollback while ordinary output survives.
  it("strips OSC 10/11 sequences from replayed scrollback but keeps normal output", async () => {
    const workspaceId = "workspace-main";
    const terminalId = "osc-strip-terminal";
    const wsUrl = `ws://127.0.0.1:${server.port}/terminal?workspaceId=${workspaceId}&terminalId=${terminalId}`;

    // OSC 11 (background) query + OSC 10 (foreground) rgb: report, plus a
    // marker whose *source text* (`DONE""MARKER`) differs from its emitted
    // output (`DONEMARKER`), so the marker we assert on can only come from
    // executed output — never the shell's echo of the typed command line.
    // `\\033`/`\\007` are literal backslash-escapes handed to the shell's
    // printf; only its *execution* produces the raw ESC (0x1b) / BEL (0x07)
    // bytes that end up in scrollback.
    const OSC11_QUERY = "\x1b]11;?\x07";
    const OSC10_REPORT = "\x1b]10;rgb:e8e8/e8e8/e8e8\x07";
    const MARKER = "DONEMARKER";
    const command =
      "printf '\\033]11;?\\007\\033]10;rgb:e8e8/e8e8/e8e8\\007'; echo DONE\"\"MARKER\r";

    // --- Connection 1: spawn the PTY, run the command, wait until the raw
    //     OSC bytes appear in live output (proving they're now in scrollback).
    const ws1 = new WebSocket(wsUrl, {
      headers: { Cookie: `band_token=${DEFAULT_TOKEN}` },
    });

    let live = Buffer.alloc(0);
    let sentCommand = false;

    await new Promise<void>((resolve, reject) => {
      ws1.on("open", () => {
        ws1.send(JSON.stringify({ type: "init" }));
      });
      ws1.on("message", (data: Buffer, isBinary: boolean) => {
        if (!sentCommand) {
          // First frame proves the session is attached and the persistent
          // message listener is live — now send the command.
          sentCommand = true;
          ws1.send(command);
          return;
        }
        if (!isBinary) return; // skip JSON control frames (title, etc.)
        live = Buffer.concat([live, data]);
        // Live output is NOT stripped, so the raw OSC 11 query round-trips
        // here. Once we see it, the bytes are guaranteed in scrollback.
        if (live.includes(Buffer.from(OSC11_QUERY, "binary"))) {
          resolve();
        }
      });
      ws1.on("error", reject);
      setTimeout(
        () => reject(new Error("OSC query never appeared in live output within 10 s")),
        10_000,
      );
    });

    await new Promise<void>((r) => {
      ws1.on("close", () => r());
      ws1.close();
    });

    // --- Connection 2: reconnect to the same terminal. The server replays
    //     the buffered scrollback through stripTerminalQueries.
    const ws2 = new WebSocket(wsUrl, {
      headers: { Cookie: `band_token=${DEFAULT_TOKEN}` },
    });

    let replay = Buffer.alloc(0);

    await new Promise<void>((resolve, reject) => {
      ws2.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return;
        replay = Buffer.concat([replay, data]);
        // The marker proves scrollback was actually replayed (guards against
        // a false pass where an empty buffer trivially contains no OSC).
        if (replay.includes(MARKER)) {
          resolve();
        }
      });
      ws2.on("error", reject);
      setTimeout(
        () => reject(new Error("Marker never appeared in replayed scrollback within 10 s")),
        10_000,
      );
    });

    ws2.close();

    // Ordinary output survived replay.
    expect(replay.includes(MARKER)).toBe(true);
    // Both OSC forms — the `?` query and the `rgb:` report — were stripped.
    expect(replay.includes(Buffer.from(OSC11_QUERY, "binary"))).toBe(false);
    expect(replay.includes(Buffer.from(OSC10_REPORT, "binary"))).toBe(false);
    // Nothing starting an OSC 10/11/12 escape (`ESC ] 1x`) should remain.
    expect(replay.includes(Buffer.from("\x1b]10", "binary"))).toBe(false);
    expect(replay.includes(Buffer.from("\x1b]11", "binary"))).toBe(false);
  });
});
