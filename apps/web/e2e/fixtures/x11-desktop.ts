/**
 * A real virtual desktop for the desktop viewer e2e: Xvfb, x11vnc and an `xev` window that covers
 * the screen and logs every key and button event the X server delivers to it. A key or click that
 * shows up in that log went through noVNC, the hub's filter, the worker link and x11vnc into the
 * display, which is what the stand-in RFB server cannot prove.
 *
 * Two ways to run it:
 * - Native, when `Xvfb`, `x11vnc` and `xev` are on PATH (the CI e2e job installs the apt packages
 *   `xvfb x11vnc x11-utils`). x11vnc listens on loopback only.
 * - Docker, when `BAND_E2E_DESKTOP_IMAGE` names an image that has the three (the desktop worker
 *   image does). The container's 5900 is published on 127.0.0.1 only. This is the way on macOS.
 *
 * `startX11Desktop` returns null when neither is available.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer, Socket } from "node:net";

export const DESKTOP_WIDTH = 1280;
export const DESKTOP_HEIGHT = 800;

export interface X11Desktop {
  /** The x11vnc port on 127.0.0.1. */
  port: number;
  /** The `xev` output so far. */
  events(): string;
  close(): Promise<void>;
}

function onPath(bin: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Resolves once something answers an RFB version on the port. */
async function waitForRfb(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = new Socket();
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(1000, () => done(false));
      socket.once("data", (data) => done(data.toString("latin1").startsWith("RFB ")));
      socket.once("error", () => done(false));
      socket.connect(port, "127.0.0.1");
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`x11vnc did not answer on 127.0.0.1:${port}`);
}

const XEV_ARGS = `-geometry ${DESKTOP_WIDTH}x${DESKTOP_HEIGHT}+0+0 -event keyboard -event button`;

/** Resolves when the child has exited, or at once when it already has. */
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/**
 * Starts Xvfb on a display it picks itself (`-displayfd`), so it never shares one with another
 * X server, and resolves with that display once the server accepts connections.
 */
function startXvfb(): Promise<{ xvfb: ChildProcess; display: string }> {
  const xvfb = spawn(
    "Xvfb",
    [
      "-displayfd",
      "3",
      "-screen",
      "0",
      `${DESKTOP_WIDTH}x${DESKTOP_HEIGHT}x24`,
      "-nolisten",
      "tcp",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      xvfb.kill("SIGKILL");
      reject(new Error("Xvfb did not report a display within 15s"));
    }, 15_000);
    xvfb.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Xvfb exited with code ${code} before it reported a display`));
    });
    (xvfb.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const match = /^(\d+)\n/.exec(out);
      if (match) {
        clearTimeout(timer);
        xvfb.removeAllListeners("exit");
        resolve({ xvfb, display: `:${match[1]}` });
      }
    });
  });
}

async function startNative(): Promise<X11Desktop> {
  const port = await freePort();
  const procs: ChildProcess[] = [];
  const close = async () => {
    for (const p of procs.reverse()) p.kill("SIGKILL");
    await Promise.all(procs.map(exited));
  };
  let log = "";
  try {
    const { xvfb, display } = await startXvfb();
    procs.push(xvfb);
    const env = { ...process.env, DISPLAY: display };
    const xev = spawn("xev", XEV_ARGS.split(" "), { env, stdio: ["ignore", "pipe", "ignore"] });
    xev.stdout?.on("data", (chunk: Buffer) => {
      log += chunk.toString("utf8");
    });
    procs.push(xev);
    procs.push(
      spawn(
        "x11vnc",
        [
          "-display",
          display,
          "-localhost",
          "-rfbport",
          String(port),
          "-nopw",
          "-forever",
          "-shared",
        ].concat(["-noxdamage", "-quiet"]),
        { env, stdio: "ignore" },
      ),
    );
    await waitForRfb(port, 15_000);
  } catch (err) {
    await close();
    throw err;
  }
  return { port, events: () => log, close };
}

async function startDocker(image: string): Promise<X11Desktop> {
  // x11vnc listens on the container's interfaces, and the port is published on the host's
  // loopback only.
  const script = [
    `Xvfb :99 -screen 0 ${DESKTOP_WIDTH}x${DESKTOP_HEIGHT}x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &`,
    "export DISPLAY=:99",
    "n=0; until xdpyinfo >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 100 ] && exit 1; sleep 0.1; done",
    `xev ${XEV_ARGS} >/tmp/xev.log 2>&1 &`,
    "exec x11vnc -display :99 -rfbport 5900 -nopw -forever -shared -noxdamage -quiet",
  ].join("\n");
  const id = execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--publish",
      "127.0.0.1::5900",
      "--label",
      "band.e2e=x11-desktop",
    ].concat(["--entrypoint", "sh", image, "-c", script]),
    { encoding: "utf8" },
  ).trim();
  const close = async () => {
    try {
      execFileSync("docker", ["rm", "--force", id], { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  };
  try {
    const mapping = execFileSync("docker", ["port", id, "5900/tcp"], { encoding: "utf8" });
    const port = Number(/:(\d+)\s*$/m.exec(mapping.trim())?.[1]);
    if (!port) throw new Error(`no published port for 5900: ${mapping}`);
    await waitForRfb(port, 30_000);
    return {
      port,
      events: () => {
        try {
          return execFileSync("docker", ["exec", id, "cat", "/tmp/xev.log"], { encoding: "utf8" });
        } catch {
          return "";
        }
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

export async function startX11Desktop(): Promise<X11Desktop | null> {
  const image = process.env.BAND_E2E_DESKTOP_IMAGE;
  if (image) return startDocker(image);
  if (onPath("Xvfb") && onPath("x11vnc") && onPath("xev")) {
    return startNative();
  }
  return null;
}
