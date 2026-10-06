import { accessSync, constants } from "node:fs";
import { connect, type Socket } from "node:net";
import { delimiter, join } from "node:path";
import type { Duplex } from "@band-app/host-api";
import { prependBinDirs } from "../process/path";

/** The port x11vnc listens on, on loopback only. `BAND_DESKTOP_VNC_PORT` changes it. */
const DEFAULT_VNC_PORT = 5900;
const CONNECT_TIMEOUT_MS = 5_000;

function vncPort(): number {
  const port = Number(process.env.BAND_DESKTOP_VNC_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_VNC_PORT;
}

function onPath(bin: string): boolean {
  for (const dir of prependBinDirs(process.env.PATH).split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

/** Why this machine has no desktop, or null when it has one. Read on every call. */
export function desktopUnavailableReason(): string | null {
  if (!process.env.DISPLAY) return "no display: DISPLAY is not set on this host";
  if (!onPath("x11vnc")) return "x11vnc is not installed on this host";
  return null;
}

/**
 * Connects to x11vnc on loopback. The VNC server has no password because the link is the only
 * way in, so this never dials anything but 127.0.0.1.
 */
export async function openDesktop(): Promise<Duplex> {
  const reason = desktopUnavailableReason();
  if (reason) throw new Error(`This host has no desktop: ${reason}`);
  const port = vncPort();
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    const fail = (err: Error) => {
      s.destroy();
      reject(
        new Error(
          `This host has no desktop: cannot reach x11vnc on 127.0.0.1:${port} (${err.message})`,
        ),
      );
    };
    s.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("timed out")));
    s.once("error", fail);
    s.once("connect", () => {
      s.setTimeout(0);
      s.off("error", fail);
      resolve(s);
    });
  });
  socket.setNoDelay(true);
  socket.on("error", () => socket.destroy());
  return {
    write: (chunk) => {
      if (!socket.destroyed && socket.writable) socket.write(chunk);
    },
    output: socket,
    close: () => socket.destroy(),
  };
}
