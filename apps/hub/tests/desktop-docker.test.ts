// Integration test for the desktop worker image (plan step 7.1, scenarios S1 and S2). A real hub runs
// `runners/docker` with `desktop: true` against a real docker daemon. The container starts Xvfb, fluxbox
// and x11vnc, the worker reports the `desktop` capability, a WebSocket client through the hub receives
// the RFB handshake from the real x11vnc, and a terminal on that worker has DISPLAY set and a working
// `xdpyinfo`.
//
// It needs a docker daemon and the image from docker/worker-desktop.Dockerfile. Set
// BAND_DOCKER_TEST_DESKTOP_IMAGE to the image name to run it. Without it the file is skipped, except on
// Linux CI (`CI=true`), where a missing image or daemon is a failure. The CI
// `docker` job builds both images and runs it, with `--network host` so the container reaches the hub.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

const IMAGE = process.env.BAND_DOCKER_TEST_DESKTOP_IMAGE ?? "";
const NETWORK = process.env.BAND_DOCKER_TEST_NETWORK ?? "host";
const TOKEN = "desktop-docker-shared-secret";

interface ReposList {
  repos: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
}
interface HostsList {
  hosts: Array<{ id: string; status: string; capabilities: string[] }>;
}

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

let server: ServerHandle;
let gitDaemon: ReturnType<typeof spawn> | undefined;
let hostId = "";
let worktreeId = "";

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

async function closeAndWait(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  ws.close();
  await closed;
}

function dockerHas(image: string): boolean {
  try {
    docker("image", "inspect", image);
    return true;
  } catch {
    return false;
  }
}

// Linux CI has docker, so a missing image or daemon there is a broken job, not a reason to skip. The
// jobs that run the whole hub suite set BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB=1, which skips it there.
const mustRun =
  process.env.CI === "true" &&
  process.platform === "linux" &&
  !process.env.BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB;
if (mustRun && !(IMAGE && dockerHas(IMAGE))) {
  throw new Error(
    "CI on Linux requires desktop-docker.test.ts to run: set BAND_DOCKER_TEST_DESKTOP_IMAGE to the " +
      `band-worker-desktop image a docker daemon has (got "${IMAGE}"), or set ` +
      "BAND_DOCKER_TEST_RUNS_IN_DOCKER_JOB=1 in a job that does not build it",
  );
}

describe.skipIf(!IMAGE)("the desktop worker image", () => {
  beforeAll(async () => {
    const hubHome = createTmpHome("band-desktop-docker-hub-");
    scratch.push(hubHome);
    const seed = join(tmp("band-desktop-docker-seed-"), "proj");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "hello.txt"), "hello\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "init");

    // The container clones the repository itself, so its origin is a `git daemon` on loopback.
    const origin = tmp("band-desktop-docker-origin-");
    const bare = join(origin, "proj");
    mkdirSync(bare, { recursive: true });
    git(origin, "clone", "-q", "--bare", seed, bare);
    const port = Number(process.env.BAND_DOCKER_TEST_GIT_PORT) || (await freePort());
    gitDaemon = spawn(
      "git",
      [
        "daemon",
        `--base-path=${origin}`,
        "--export-all",
        `--port=${port}`,
        "--listen=127.0.0.1",
        origin,
      ],
      { stdio: "ignore" },
    );
    await new Promise((r) => setTimeout(r, 500));
    const gitUrl = process.env.BAND_DOCKER_TEST_GIT_URL ?? `git://127.0.0.1:${port}`;
    git(seed, "remote", "add", "origin", `${gitUrl}/proj`);

    seedSettings(hubHome, { tokenSecret: TOKEN });
    seedState(hubHome, {
      repos: [
        {
          name: "proj",
          path: seed,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: seed }],
        },
      ],
    });
    server = await startServer({
      tmpHome: hubHome,
      remoteHost: false,
      port: Number(process.env.BAND_DOCKER_TEST_PORT) || undefined,
      env: { BAND_SERVE_UI: "false", BAND_REAPER_INTERVAL_MS: "500" },
    });
    await m("settings.update", {
      runners: [
        {
          id: "desktop",
          spawn: "bundled:docker",
          destroy: "bundled:docker",
          status: "bundled:docker",
          labels: { pool: "desktop" },
          isolation: "container",
          desktop: true,
          maxConcurrent: 1,
          timeoutSec: 150,
          env: {
            BAND_DOCKER_DESKTOP_IMAGE: IMAGE,
            BAND_DOCKER_NETWORK: NETWORK,
            ...(process.env.BAND_DOCKER_TEST_HUB_URL
              ? { BAND_HUB_URL: process.env.BAND_DOCKER_TEST_HUB_URL }
              : {}),
            BAND_IDLE_EXIT: "300s",
            ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
          },
        },
      ],
    });

    await m("worktrees.create", {
      repo: "proj",
      branch: "desktop-a",
      placement: { labels: { pool: "desktop" }, environment: { isolation: "container" } },
    });
    const wt = await waitFor(
      async () =>
        (await q<ReposList>("repos.list")).repos
          .find((p) => p.name === "proj")
          ?.worktrees.find((w) => w.name === "desktop-a"),
      { label: "the worktree exists on the desktop worker", timeoutMs: 180_000, intervalMs: 500 },
    );
    hostId = wt.hostId as string;
    worktreeId = `proj-${wt.name}`;
  }, 400_000);

  afterAll(async () => {
    try {
      const left = docker("ps", "--all", "--quiet", "--filter", "label=band.runner=desktop");
      for (const id of left.split("\n").filter(Boolean)) docker("rm", "--force", "--volumes", id);
    } catch {
      // Nothing to clean up.
    }
    gitDaemon?.kill();
    await server?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("reports the desktop capability and serves an RFB handshake through the hub (S1)", async () => {
    const hosts = (await q<HostsList>("hosts.list")).hosts;
    expect(hosts.find((h) => h.id === hostId)?.capabilities).toContain("desktop");

    const ws = new WebSocket(
      `${server.url.replace("http", "ws")}/api/hosts/${hostId}/desktop`,
      ["binary"],
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    let received = "";
    ws.on("message", (data: Buffer) => {
      received += data.toString("latin1");
    });
    try {
      await waitFor(() => (/^RFB 003\.00\d\n/.test(received) ? true : undefined), {
        label: "the RFB handshake",
        timeoutMs: 30_000,
      });
    } finally {
      await closeAndWait(ws);
    }
  }, 60_000);

  it("sends a framebuffer from the real desktop through the hub (7.2 S1)", async () => {
    // A bare RFB client (security None, as x11vnc -nopw offers). The hub keeps it view-only, which
    // lets FramebufferUpdateRequest through, so the real Xvfb screen reaches this socket.
    const ws = new WebSocket(
      `${server.url.replace("http", "ws")}/api/hosts/${hostId}/desktop`,
      ["binary"],
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    let held = Buffer.alloc(0);
    ws.on("message", (data: Buffer) => {
      held = Buffer.concat([held, data]);
    });
    const take = async (size: number, label: string): Promise<Buffer> => {
      await waitFor(() => (held.length >= size ? true : undefined), {
        label,
        timeoutMs: 30_000,
      });
      const out = held.subarray(0, size);
      held = held.subarray(size);
      return out;
    };
    try {
      await take(12, "the server version");
      ws.send(Buffer.from("RFB 003.008\n"));
      const types = await take(2, "the security types");
      expect(types[0]).toBe(1);
      ws.send(Buffer.from([1])); // None
      await take(4, "the security result");
      ws.send(Buffer.from([1])); // ClientInit, shared
      const init = await take(24, "ServerInit");
      const width = init.readUInt16BE(0);
      const height = init.readUInt16BE(2);
      expect(width).toBeGreaterThan(0);
      await take(init.readUInt32BE(20), "the desktop name");

      const request = Buffer.alloc(10);
      request.writeUInt8(3, 0);
      request.writeUInt8(0, 1); // not incremental
      request.writeUInt16BE(width, 6);
      request.writeUInt16BE(height, 8);
      ws.send(request);
      const update = await take(4, "a FramebufferUpdate");
      expect(update[0]).toBe(0);
      expect(update.readUInt16BE(2)).toBeGreaterThan(0);
      // The first rectangle's header and the start of its pixels follow.
      const rect = await take(12 + 1024, "the first rectangle");
      expect(rect.readUInt16BE(4)).toBeGreaterThan(0);
    } finally {
      await closeAndWait(ws);
    }
  }, 90_000);

  it("has no x11vnc listener outside loopback (constraint)", () => {
    const [container] = docker("ps", "--quiet", "--filter", `label=band.worker=${hostId}`)
      .split("\n")
      .filter(Boolean);
    const sockets = docker(
      "exec",
      container as string,
      "sh",
      "-c",
      "cat /proc/net/tcp /proc/net/tcp6",
    );
    // Port 5900 is 170C. A listening socket (state 0A) must be bound to 127.0.0.1 or ::1 only.
    const listeners = sockets
      .split("\n")
      .filter((l) => /:170C\s/.test(l) && /\s0A\s/.test(l))
      .map((l) => l.trim().split(/\s+/)[1] ?? "");
    expect(listeners.length).toBeGreaterThan(0);
    for (const local of listeners) {
      expect(["0100007F:170C", "00000000000000000000000001000000:170C"]).toContain(local);
    }
  });

  it("gives a terminal on the worker DISPLAY and a working xdpyinfo (S2)", async () => {
    const created = await m<{ terminalId: string }>("terminal.create", { worktreeId });
    const socket = await TerminalSocket.open(server, {
      worktreeId,
      terminalId: created.terminalId,
      token: TOKEN,
    });
    try {
      socket.type('echo display=$DISPLAY; echo xdpy=$(xdpyinfo | grep -c "dimensions:")\r');
      await socket.waitForOutput("display=:99");
      await socket.waitForOutput("xdpy=1");
    } finally {
      await socket.close();
    }
  }, 60_000);
});
