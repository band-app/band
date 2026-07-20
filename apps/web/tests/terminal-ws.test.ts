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
// This is a black-box integration test against the production server
// bundle (`dist/start-server.mjs`), with a real WebSocket client. No mocks.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTRPCClient, createWSClient, httpBatchLink, wsLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AppRouter } from "../src/server/api/router";
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
      // Spawn the PTY via an `attach` (the client's first message now carries
      // its fitted dims and drives the request-driven replay). It's consumed
      // as the one-shot handler's pending message and processed by the
      // persistent `message` listener `attachSession` installs, which also
      // serves ping/pong — so the server's replay ack proves that listener is
      // live before we ping (a ping sent earlier would race ahead of it and be
      // dropped).
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24 }));
      });
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!pinged) {
          // First frame (the `attached` ack / shell prompt) proves the session
          // is attached and the message listener is live — now ping.
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

  // OSC 11 (background) query + OSC 10 (foreground) rgb: report, plus a
  // marker whose *source text* (`DONE""MARKER`) differs from its emitted
  // output (`DONEMARKER`), so the marker we assert on can only come from
  // executed output — never the shell's echo of the typed command line.
  // `\\033`/`\\007` are literal backslash-escapes handed to the shell's
  // printf; only its *execution* produces the raw ESC (0x1b) / BEL (0x07)
  // bytes that end up in scrollback.
  const OSC11_QUERY = "\x1b]11;?\x07";
  const OSC10_REPORT = "\x1b]10;rgb:e8e8/e8e8/e8e8\x07";
  const OSC12_QUERY = "\x1b]12;?\x07";
  const MARKER = "DONEMARKER";
  const COMMAND =
    "printf '\\033]11;?\\007\\033]10;rgb:e8e8/e8e8/e8e8\\007\\033]12;?\\007'; echo DONE\"\"MARKER\r";

  const WORKSPACE_ID = "workspace-main";

  // Spawn a PTY over the `/terminal` WebSocket, run the OSC-emitting command,
  // and resolve only once BOTH the raw OSC bytes AND the trailing marker have
  // appeared in live output — which guarantees the whole command's output
  // (queries + marker) is buffered in the server-side scrollback. Waiting for
  // the marker too matters: the PTY can deliver the OSC bytes and `DONEMARKER`
  // in separate chunks, so resolving on the OSC alone could close the socket
  // before the marker reaches scrollback and make the replay assertions flake.
  // Then close the socket; the pool keeps the PTY alive for reconnect/replay.
  async function seedOscScrollback(terminalId: string): Promise<void> {
    const wsUrl = `ws://127.0.0.1:${server.port}/terminal?workspaceId=${WORKSPACE_ID}&terminalId=${terminalId}`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: `band_token=${DEFAULT_TOKEN}` } });

    let live = Buffer.alloc(0);
    let sentCommand = false;

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24 }));
      });
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!sentCommand) {
          // First frame (the `attached` ack) proves the session is attached
          // and the persistent message listener is live — now send the command.
          sentCommand = true;
          ws.send(COMMAND);
          return;
        }
        if (!isBinary) return; // skip JSON control frames (title, etc.)
        live = Buffer.concat([live, data]);
        // Live output is NOT stripped, so the raw OSC query round-trips here.
        // Wait for the OSC bytes and the marker so the full command output is
        // guaranteed in scrollback before we close.
        if (live.includes(Buffer.from(OSC11_QUERY)) && live.includes(Buffer.from(MARKER))) {
          resolve();
        }
      });
      ws.on("error", reject);
      setTimeout(
        () => reject(new Error("OSC query + marker never appeared in live output within 10 s")),
        10_000,
      );
    });

    await new Promise<void>((r) => {
      ws.on("close", () => r());
      ws.close();
    });
  }

  // Regression for band-app/band#613: a stale OSC 10/11/12 color query sitting
  // in scrollback used to survive replay (stripTerminalQueries only matched CSI
  // sequences). The client's xterm.js then answered the replayed query, the
  // dashboard forwarded the answer to the PTY, and the shell's line editor
  // inserted the printable remainder (`11;rgb:1e1e/1e1e/1e1e…`) as literal text
  // at the prompt. This test proves the OSC bytes are stripped from replayed
  // scrollback while ordinary output survives.
  it("strips OSC 10/11 sequences from WebSocket scrollback replay but keeps normal output", async () => {
    const terminalId = "osc-strip-ws";
    await seedOscScrollback(terminalId);

    // Reconnect to the same terminal. Replay is request-driven: the client
    // sends an `attach` carrying its fitted dims, and the server serializes the
    // mirror at those dims and replays it through stripTerminalQueries on the
    // `/terminal` WS path.
    const wsUrl = `ws://127.0.0.1:${server.port}/terminal?workspaceId=${WORKSPACE_ID}&terminalId=${terminalId}`;
    const ws2 = new WebSocket(wsUrl, {
      headers: { Cookie: `band_token=${DEFAULT_TOKEN}` },
    });

    // The server replays the whole serialized snapshot in a single binary
    // `ws.send`, so the FIRST binary frame is exactly the replayed state.
    // Capture only that frame, LATCHED — the post-replay `nudgeResize` makes
    // the shell redraw its prompt, and those live frames can arrive before
    // the socket close completes; without the latch they'd overwrite the
    // captured snapshot and muddy the OSC assertions.
    let replay: Buffer | null = null;

    await new Promise<void>((resolve, reject) => {
      ws2.on("open", () => {
        ws2.send(JSON.stringify({ type: "attach", cols: 80, rows: 24 }));
      });
      ws2.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary || replay !== null) return; // skip JSON control frames + post-replay live output
        replay = data;
        resolve();
      });
      ws2.on("error", reject);
      setTimeout(() => reject(new Error("No replayed scrollback frame within 10 s")), 10_000);
    });

    ws2.close();

    // Non-null: `resolve` only fires after the latch assignment above.
    const frame = replay as unknown as Buffer;
    // Ordinary output survived replay — positive anchor for the negatives.
    expect(frame.toString()).toContain(MARKER);
    // Every OSC form — the `?` query (11/12) and the `rgb:` report (10) — was
    // stripped.
    expect(frame.includes(Buffer.from(OSC11_QUERY))).toBe(false);
    expect(frame.includes(Buffer.from(OSC10_REPORT))).toBe(false);
    expect(frame.includes(Buffer.from(OSC12_QUERY))).toBe(false);
    // Nothing starting an OSC 10/11/12 escape (`ESC ] 1x`) should remain.
    expect(frame.includes(Buffer.from("\x1b]10"))).toBe(false);
    expect(frame.includes(Buffer.from("\x1b]11"))).toBe(false);
    expect(frame.includes(Buffer.from("\x1b]12"))).toBe(false);
  });

  // The second replay path (band-app/band#613): the tRPC `terminal.stream`
  // subscription replays scrollback before streaming live output. It
  // previously replayed raw scrollback with no stripping at all, so the same
  // OSC leak applied. This drives the real tRPC client over the production WS
  // transport and asserts the first replayed `output` frame is stripped.
  it("strips OSC 10/11 sequences from the tRPC terminal.stream scrollback replay", async () => {
    const terminalId = "osc-strip-trpc";
    await seedOscScrollback(terminalId);

    // The tRPC WS transport authenticates via the same `band_token` cookie the
    // HTTP upgrade handler checks. `createWSClient` constructs its socket as
    // `new WebSocket(url, protocols)` with no way to set headers, so wrap the
    // `ws` implementation to always attach the cookie.
    class CookieWebSocket extends WebSocket {
      constructor(address: string, protocols?: string | string[]) {
        super(address, protocols, {
          headers: { Cookie: `band_token=${DEFAULT_TOKEN}` },
        });
      }
    }

    const wsClient = createWSClient({
      url: `ws://127.0.0.1:${server.port}/trpc`,
      WebSocket: CookieWebSocket as unknown as typeof globalThis.WebSocket,
    });
    const client = createTRPCClient<AppRouter>({ links: [wsLink({ client: wsClient })] });

    // The subscription replays the serialized snapshot as its first
    // `output` event.
    const firstOutput = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("No output event from terminal.stream within 10 s")),
        10_000,
      );
      const sub = client.terminal.stream.subscribe(
        { terminalId, replay: true },
        {
          onData: (evt) => {
            if (evt.type === "output") {
              clearTimeout(timer);
              sub.unsubscribe();
              resolve(evt.data);
            }
          },
          onError: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        },
      );
    });

    wsClient.close();

    // The replayed scrollback (a plain string on this path) kept normal
    // output but had every OSC sequence stripped.
    expect(firstOutput).toContain(MARKER);
    expect(firstOutput).not.toContain(OSC11_QUERY);
    expect(firstOutput).not.toContain(OSC10_REPORT);
    expect(firstOutput).not.toContain(OSC12_QUERY);
    expect(firstOutput).not.toContain("\x1b]10");
    expect(firstOutput).not.toContain("\x1b]11");
    expect(firstOutput).not.toContain("\x1b]12");
  });

  // Third scrollback surface (band-app/band#613): the `terminal.output` tRPC
  // query returns the buffered scrollback on demand. A client rendering that
  // into a terminal emulator would hit the same OSC leak, so it strips too.
  // Driven over the real HTTP tRPC transport.
  it("strips OSC 10/11/12 sequences from the terminal.output query response", async () => {
    const terminalId = "osc-strip-output";
    await seedOscScrollback(terminalId);

    const client = createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${server.url}/trpc`,
          headers: { Cookie: `band_token=${DEFAULT_TOKEN}` },
        }),
      ],
    });

    const { output } = await client.terminal.output.query({ terminalId });

    expect(output).toContain(MARKER);
    expect(output).not.toContain(OSC11_QUERY);
    expect(output).not.toContain(OSC10_REPORT);
    expect(output).not.toContain(OSC12_QUERY);
    expect(output).not.toContain("\x1b]10");
    expect(output).not.toContain("\x1b]11");
    expect(output).not.toContain("\x1b]12");
  });
});

// Negative-auth coverage: the WebSocket upgrade and every HTTP request are
// gated on the `band_token` cookie (see the start-server.ts upgrade handler
// and auth.ts). A seeded `tokenSecret` makes the server enforce the token, so
// a request without it must be rejected.
describe("terminal WebSocket — authentication", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
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

  it("returns 401 for an HTTP request without the band_token cookie", async () => {
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(401);
  });

  it("rejects a /terminal WebSocket upgrade without the band_token cookie", async () => {
    // No cookie → the upgrade handler destroys the socket before the 101
    // handshake, so the client never opens. Assert we observe a failure
    // (error / unexpected-response / close) and never an `open`.
    const wsUrl = `ws://127.0.0.1:${server.port}/terminal?workspaceId=workspace-main&terminalId=noauth`;
    const ws = new WebSocket(wsUrl); // deliberately no Cookie header

    const opened = await new Promise<boolean>((resolve, reject) => {
      ws.on("open", () => resolve(true));
      ws.on("error", () => resolve(false));
      ws.on("unexpected-response", () => resolve(false));
      ws.on("close", () => resolve(false));
      setTimeout(() => reject(new Error("No open/error/close within 10 s")), 10_000);
    });

    expect(opened).toBe(false);
    ws.close();
  });
});

// Serialized replay on reconnect — the user-observable surface of the
// headless-mirror change. The pool used to replay the raw scrollback buffer:
// a 100 KB tail slice that can start mid-escape-sequence, so TUI apps drawn
// with relative cursor motion (claude-code, vim) landed their moves on the
// wrong rows after a reload/reconnect. Now the first binary frame of a
// `/terminal` reconnect is `serialize()` output — a clean reconstruction of
// the terminal *state* (screen, alt buffer, scrollback), not the historical
// byte stream. These tests drive that surface end-to-end: real server, real
// PTY, real WS reconnect, asserting on the exact first replay frame.
//
// Escape sequences are emitted through `/bin/bash -c 'printf …'` so
// octal-escape handling is deterministic regardless of the host shell (same
// reasoning as the SHELL pin above), and marker strings are split with `""`
// in the command text so the shell's echo of the typed line can never
// satisfy an assertion — only executed output can.
//
// Not asserted here: the `nudgeResize` SIGWINCH pair fired after the replay
// (ws.ts) — its only hermetic observable is the PTY dims, covered at pool
// level in terminal-pool-nudge-resize.test.ts; observing the resulting
// repaint would need a SIGWINCH-aware TUI binary in CI.
describe("terminal WebSocket — serialized replay on reconnect", () => {
  let server: ServerHandle;
  let tmpHome: string;

  const WORKSPACE_ID = "workspace-main";

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
    server = await startServer(tmpHome, { SHELL: "/bin/bash" });
  });

  afterAll(async () => {
    if (server) await server.close();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  /** Connect to a terminal, optionally resize, run a command, wait until
   *  `until` appears in live output, then close — leaving the PTY alive with
   *  its state ready for a reconnect replay. */
  async function runAndDisconnect(
    terminalId: string,
    command: string,
    until: string,
    resize?: { cols: number; rows: number },
  ): Promise<void> {
    const wsUrl = `ws://127.0.0.1:${server.port}/terminal?workspaceId=${WORKSPACE_ID}&terminalId=${terminalId}`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: `band_token=${DEFAULT_TOKEN}` } });

    let live = Buffer.alloc(0);
    let sentCommand = false;

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        // The first message carries the client's dims and drives spawn +
        // replay (request-driven). Fold in the session's target dims so the
        // PTY + mirror come up at that width before any output is drawn.
        const dims = resize ?? { cols: 80, rows: 24 };
        ws.send(JSON.stringify({ type: "attach", cols: dims.cols, rows: dims.rows }));
      });
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!sentCommand) {
          // First frame (the `attached` ack) proves the session is attached
          // and the persistent message listener is live — now send the command.
          sentCommand = true;
          ws.send(command);
          return;
        }
        if (!isBinary) return; // skip JSON control frames (title, etc.)
        live = Buffer.concat([live, data]);
        if (live.includes(Buffer.from(until))) resolve();
      });
      ws.on("error", reject);
      setTimeout(
        () => reject(new Error(`"${until}" never appeared in live output within 10 s`)),
        10_000,
      );
    });

    await new Promise<void>((r) => {
      ws.on("close", () => r());
      ws.close();
    });
  }

  /** Reconnect to a terminal and capture the FIRST binary frame — the
   *  serialized replay snapshot (single `ws.send` on the server side). The
   *  latch matters: the post-replay `nudgeResize` makes the shell redraw its
   *  prompt, and those live frames arrive before `close()` completes — an
   *  unlatched `replay = data` would let them clobber the captured snapshot. */
  async function captureReplayFrame(
    terminalId: string,
    dims: { cols: number; rows: number } = { cols: 80, rows: 24 },
  ): Promise<Buffer> {
    const wsUrl = `ws://127.0.0.1:${server.port}/terminal?workspaceId=${WORKSPACE_ID}&terminalId=${terminalId}`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: `band_token=${DEFAULT_TOKEN}` } });

    let replay: Buffer | null = null;
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        // Request the replay carrying the reconnecting client's fitted dims;
        // the server resizes the mirror to these BEFORE serializing.
        ws.send(JSON.stringify({ type: "attach", cols: dims.cols, rows: dims.rows }));
      });
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary || replay !== null) return;
        replay = data;
        resolve();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("No replay frame within 10 s")), 10_000);
    });

    await new Promise<void>((r) => {
      ws.on("close", () => r());
      ws.close();
    });
    // Non-null: `resolve` only fires after the latch assignment above.
    return replay as unknown as Buffer;
  }

  it("replays the final TUI screen state on reconnect instead of the historical bytes", async () => {
    const terminalId = "serialize-replay-tui";

    // TUI-style drawing: enter the alt screen, print TEMPMARKER at row 5,
    // move back, erase the line, print FINALMARKER in its place, park the
    // cursor on row 8 so the shell prompt that follows can't touch row 5.
    await runAndDisconnect(
      terminalId,
      `/bin/bash -c 'printf "\\033[?1049h\\033[5;5HTEMP""MARKER\\033[5;5H\\033[2KFINAL""MARKER\\033[8;1H"'\r`,
      "FINALMARKER",
    );

    const replay = await captureReplayFrame(terminalId);
    const text = replay.toString();

    // The snapshot is the *state*: the surviving text is there and the
    // alt-buffer switch is reconstructed…
    expect(text).toContain("FINALMARKER");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — matching the real alt-buffer escape sequence
    expect(text).toMatch(/\x1b\[\?(?:47|1047|1049)h/);
    // …and the erased text is NOT — proof the frame is a serialized screen,
    // not the raw byte history (which contained TEMPMARKER before the erase).
    expect(text).not.toContain("TEMPMARKER");
  }, 30_000);

  it("replays at the resized dimensions — the mirror follows PTY resizes", async () => {
    const terminalId = "serialize-replay-resize";

    // Draw on row 28 and then row 24 after growing to 120x30. If the
    // server-side mirror were still 24 rows, both cursor moves would clamp
    // to row 24 and SHALLOWROW would overwrite DEEPROW — so both markers
    // surviving in the replay proves the mirror followed the resize.
    await runAndDisconnect(
      terminalId,
      `/bin/bash -c 'printf "\\033[28;1HDEEP""ROW\\033[24;1HSHALLOW""ROW\\033[29;1H"'\r`,
      "SHALLOWROW",
      { cols: 120, rows: 30 },
    );

    // Reconnect at the same dims the session drew at. Replay is now
    // request-driven and resize-before-serialize, so the reconnecting client's
    // dims set the serialize geometry — attaching at 120x30 keeps row 28 in
    // range, proving the mirror still holds the deep-row content.
    const replay = await captureReplayFrame(terminalId, { cols: 120, rows: 30 });
    const text = replay.toString();
    expect(text).toContain("DEEPROW");
    expect(text).toContain("SHALLOWROW");
  }, 30_000);

  // Reconnect width-sync (the reflow-scatter fix). Render the captured replay
  // snapshot through a headless xterm at the reconnecting client's width —
  // exactly what the browser does with the bytes — and assert the TUI grid is
  // reproduced at THAT width. If the server serialized at the mirror's stale
  // width instead of resizing to the client's dims first, an alt-screen
  // (TUI) paragraph re-wraps at the wider client width and words that belong
  // on a later row scatter onto row 0.
  async function renderSnapshotRows(snapshot: Buffer, cols: number, rows = 24): Promise<string[]> {
    // Same CJS/ESM interop dance the pool uses (see terminal-pool.ts): the
    // class is on the namespace under tsx/esbuild and on `.default` under a
    // plain Node import.
    const headlessNs = (await import("@xterm/headless")) as
      | typeof import("@xterm/headless")
      | { default: typeof import("@xterm/headless") };
    const { Terminal } = "Terminal" in headlessNs ? headlessNs : headlessNs.default;
    const term = new Terminal({ cols, rows, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(new Uint8Array(snapshot), resolve));
    const out: string[] = [];
    const buf = term.buffer.active;
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(i);
      out.push(line ? line.translateToString(true) : "");
    }
    term.dispose();
    return out;
  }

  it("serializes the reconnect snapshot at the client's width, not the stale mirror width", async () => {
    const terminalId = "serialize-replay-width-sync";

    // Draw a NATURALLY-WRAPPED alt-screen (TUI) paragraph at a NARROW width.
    // `SCATTERZEBRA` is authored via `SCATTER""ZEBRA` so the shell's echo of
    // the typed line can never satisfy the wait — only the executed printf
    // output produces the contiguous marker. It starts at column 90 of the
    // logical line: past both the 40-col session width AND the mirror's 80-col
    // default, so it belongs on a LATER row at any sane mirror width — but it
    // fits within column 120, so a snapshot re-wrapped at the wide client
    // width would pull it up onto row 0.
    const filler = "AB ".repeat(30); // 90 chars, cols 0..89
    const command = `/bin/bash -c 'printf "\\033[?1049h\\033[H${filler}SCATTER""ZEBRA and then plenty more trailing words to overflow the wide client row CD CD CD CD"'\r`;
    await runAndDisconnect(terminalId, command, "SCATTERZEBRA", { cols: 40, rows: 24 });

    // Reconnect as a WIDE client (120 cols). Request-driven replay resizes the
    // mirror to 120 BEFORE serializing, so the snapshot reproduces the 40-col
    // alt grid faithfully inside a 120-wide buffer.
    const replay = await captureReplayFrame(terminalId, { cols: 120, rows: 24 });
    const rows = await renderSnapshotRows(replay, 120);

    // Positive anchor: the marker really is in the replayed screen somewhere.
    expect(rows.join("\n")).toContain("SCATTERZEBRA");
    // The scatter assertion: a snapshot serialized at the client's width keeps
    // the marker on its authored (later) row, so row 0 is just early filler.
    // A stale-width snapshot re-wrapped at 120 would carry the marker onto
    // row 0 — the reflow scatter this fix eliminates.
    expect(rows[0]).not.toContain("SCATTERZEBRA");
    expect(rows[0]).toContain("AB ");
  }, 30_000);
});

// The pool strips color-disabling vars (NO_COLOR / FORCE_COLOR / CLICOLOR)
// inherited from the shell that launched the server — a pane spawned by a
// server started under `NO_COLOR=1` used to come up monochrome even though
// the pane advertises a truecolor terminal via COLORTERM.
describe("terminal WebSocket — color env vars stripped from spawned panes", () => {
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
    // The server itself runs with all three vars set — the pane must not
    // inherit them.
    server = await startServer(tmpHome, {
      SHELL: "/bin/bash",
      NO_COLOR: "1",
      FORCE_COLOR: "1",
      CLICOLOR: "0",
    });
  });

  afterAll(async () => {
    if (server) await server.close();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("spawns the pane shell without NO_COLOR / FORCE_COLOR / CLICOLOR", async () => {
    const terminalId = "color-env-strip";
    const wsUrl = `ws://127.0.0.1:${server.port}/terminal?workspaceId=workspace-main&terminalId=${terminalId}`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: `band_token=${DEFAULT_TOKEN}` } });

    // Markers are split with `""` in the typed command so the shell's echo
    // of the line (`NC""=${NO_COLOR:-unset}…`) can never satisfy the
    // assertion — only the executed, expanded output prints `NC=unset`.
    const COMMAND = `echo "NC""=\${NO_COLOR:-unset} FC""=\${FORCE_COLOR:-unset} CC""=\${CLICOLOR:-unset}"\r`;

    let live = Buffer.alloc(0);
    let sentCommand = false;

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24 }));
      });
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!sentCommand) {
          sentCommand = true;
          ws.send(COMMAND);
          return;
        }
        if (!isBinary) return;
        live = Buffer.concat([live, data]);
        // Resolve on either outcome so a regression fails on the assertion
        // below (with the actual values) instead of on a timeout.
        if (live.includes(Buffer.from("NC="))) resolve();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("No NC= output within 10 s")), 10_000);
    });

    await new Promise<void>((r) => {
      ws.on("close", () => r());
      ws.close();
    });

    expect(live.toString()).toContain("NC=unset FC=unset CC=unset");
  }, 30_000);
});
