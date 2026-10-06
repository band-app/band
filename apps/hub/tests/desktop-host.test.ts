// Integration test for the desktop link channel (plan step 7.1): a real hub (the production bundle,
// random port, auth on, temp dirs only) and two real `band-worker` processes. The first has a display
// and an `x11vnc` on its PATH, and a stand-in RFB server listens where x11vnc would, so the bytes
// that reach the viewer travel the whole way: WebSocket, hub, link channel, worker, TCP. The second
// has no display, so it offers no desktop and `desktop.open` fails with a message that says why.
//
// Xvfb and x11vnc themselves are covered by the CI `docker` job, which runs the real
// `band-worker-desktop` image through the hub (see desktop-docker.test.ts).

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const SHARED_TOKEN = "desktop-host-shared-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface HostView {
  id: string;
  status: "online" | "offline" | "lost" | "disposed";
  capabilities: string[];
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

let server: ServerHandle;
let rfb: Server;
let rfbPort = 0;
const workers: ChildProcess[] = [];
let withDesktop: string;
let withoutDesktop: string;

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, SHARED_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, SHARED_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

const hostById = async (id: string) =>
  (await q<{ hosts: HostView[] }>("hosts.list")).hosts.find((h) => h.id === id);

async function startWorker(name: string, env: NodeJS.ProcessEnv): Promise<string> {
  const home = tmp(`band-desktop-${name}-home-`);
  const state = tmp(`band-desktop-${name}-state-`);
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: name,
    labels: [],
  });
  const base: NodeJS.ProcessEnv = { ...process.env };
  base.DISPLAY = undefined;
  const child = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      home,
      "--state-dir",
      state,
    ],
    {
      env: { ...base, SHELL: "/bin/sh", HOME: home, BAND_HOME: join(home, ".band"), ...env },
      stdio: "ignore",
    },
  );
  workers.push(child);
  await waitFor(
    async () => ((await hostById(issued.hostId))?.status === "online" ? true : undefined),
    {
      label: `host ${name} online`,
      timeoutMs: 30_000,
    },
  );
  return issued.hostId;
}

/** Opens the desktop socket and collects what it receives until it closes. */
function viewer(hostId: string, token = SHARED_TOKEN) {
  const url = `${server.url.replace("http", "ws")}/api/hosts/${hostId}/desktop`;
  const ws = new WebSocket(url, ["binary"], { headers: { Authorization: `Bearer ${token}` } });
  let received = Buffer.alloc(0);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on("error", () => undefined);
  });
  ws.on("message", (data: Buffer) => {
    received = Buffer.concat([received, data]);
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  return { ws, opened, closed, text: () => received.toString() };
}

beforeAll(async () => {
  // Stand-in for x11vnc: sends the RFB greeting, then echoes what the viewer writes.
  rfb = createServer((socket) => {
    socket.write("RFB 003.008\n");
    socket.on("data", (d) => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => rfb.listen(0, "127.0.0.1", resolve));
  rfbPort = (rfb.address() as { port: number }).port;

  const hubHome = createTmpHome("band-desktop-hub-");
  scratch.push(hubHome);
  seedSettings(hubHome, { tokenSecret: SHARED_TOKEN });
  server = await startServer({ tmpHome: hubHome, remoteHost: false });

  // An executable named x11vnc is all `desktop` looks for. The worker never runs it.
  const bin = tmp("band-desktop-bin-");
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, "x11vnc");
  writeFileSync(stub, "#!/bin/sh\nexit 0\n");
  chmodSync(stub, 0o755);
  const systemPath = `${dirname(process.execPath)}:/usr/bin:/bin`;

  withDesktop = await startWorker("with-desktop", {
    DISPLAY: ":99",
    PATH: `${bin}:${systemPath}`,
    BAND_DESKTOP_VNC_PORT: String(rfbPort),
  });
  withoutDesktop = await startWorker("without-desktop", { PATH: systemPath });
}, 120_000);

afterAll(async () => {
  for (const w of workers) w.kill("SIGKILL");
  await new Promise<void>((resolve) => rfb?.close(() => resolve()));
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("the desktop capability", () => {
  it("is reported by a worker with a display and x11vnc", async () => {
    expect((await hostById(withDesktop))?.capabilities).toContain("desktop");
  });

  it("is not reported by a worker without a display", async () => {
    const host = await hostById(withoutDesktop);
    expect(host?.capabilities).toContain("pty");
    expect(host?.capabilities).not.toContain("desktop");
  });
});

describe("GET /api/hosts/<id>/desktop", () => {
  it("carries the RFB stream both ways", async () => {
    const v = viewer(withDesktop);
    await v.opened;
    await waitFor(() => (v.text().startsWith("RFB 003.00") ? true : undefined), {
      label: "the RFB greeting",
    });
    v.ws.send(Buffer.from("RFB 003.008\n"));
    await waitFor(() => (v.text().includes("echo:RFB 003.008") ? true : undefined), {
      label: "the echo of the client's version",
    });
    v.ws.close();
    await v.closed;
  });

  it("serves one viewer at a time, and the next one connects once the first leaves", async () => {
    const first = viewer(withDesktop);
    await first.opened;
    await waitFor(() => (first.text().startsWith("RFB") ? true : undefined), {
      label: "first RFB",
    });

    const second = viewer(withDesktop);
    expect((await second.closed).code).toBe(4409);

    first.ws.close();
    await first.closed;
    await waitFor(
      async () => {
        const next = viewer(withDesktop);
        await next.opened;
        try {
          await waitFor(() => (next.text().startsWith("RFB") ? true : undefined), {
            label: "RFB",
            timeoutMs: 1500,
          });
          return true;
        } catch {
          return undefined;
        } finally {
          next.ws.close();
          await next.closed;
        }
      },
      { label: "a new viewer after the first left" },
    );
  });

  it("closes with a message that names the missing display on a worker without one", async () => {
    const v = viewer(withoutDesktop);
    const { code, reason } = await v.closed;
    expect(code).toBe(4001);
    expect(reason).toMatch(/no desktop/);
    expect(reason).toMatch(/DISPLAY/);
  });

  it("closes for a host that does not exist", async () => {
    const v = viewer("h-nothere");
    const { code, reason } = await v.closed;
    expect(code).toBe(4001);
    expect(reason).toMatch(/Unknown host/);
  });

  it("refuses a request without a device token", async () => {
    const ws = new WebSocket(
      `${server.url.replace("http", "ws")}/api/hosts/${withDesktop}/desktop`,
    );
    // The hub destroys an unauthorized upgrade without a status line, as for every WebSocket route.
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("refused"));
    });
    expect(outcome).toBe("refused");
  });
});
