/**
 * A stand-in for x11vnc: a TCP server that speaks RFB 3.8 with security type None and draws a
 * fixed gradient. The e2e worker reaches it through `BAND_DESKTOP_VNC_PORT`, the env override
 * the worker reads when it opens the desktop, so the bytes travel the whole way: noVNC, the hub's
 * WebSocket, the worker link, the worker and this server.
 *
 * It records the key events it receives, which is the "test window that records keys": a key
 * that the hub dropped never shows up here.
 */

import { createServer, type Server, type Socket } from "node:net";

const DEFAULT_WIDTH = 64;
const DEFAULT_HEIGHT = 48;
const MIN_UPDATE_GAP_MS = 150;

interface Size {
  width: number;
  height: number;
}

export interface RfbStub {
  port: number;
  /** Keysyms of the KeyEvents received with the down flag, in order. */
  keys(): number[];
  /** Pointer events received. */
  pointerEvents(): number;
  /** The desktop size for connections made from now on (64x48 until changed). */
  setSize(width: number, height: number): void;
  close(): Promise<void>;
}

/** One rectangle of Raw pixels covering the whole desktop. */
function frame({ width, height }: Size): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Little-endian 0x00RRGGBB: bytes are B, G, R, pad.
      pixels[i] = 255 - Math.floor((x * 255) / width);
      pixels[i + 1] = Math.floor((y * 255) / height);
      pixels[i + 2] = 200;
      pixels[i + 3] = 0;
    }
  }
  const header = Buffer.alloc(16);
  header.writeUInt8(0, 0); // FramebufferUpdate
  header.writeUInt16BE(1, 2); // one rectangle
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(width, 8);
  header.writeUInt16BE(height, 10);
  header.writeInt32BE(0, 12); // Raw encoding
  return Buffer.concat([header, pixels]);
}

/** An update with no rectangles: the answer to an incremental request, since nothing changed. */
function emptyUpdate(): Buffer {
  return Buffer.from([0, 0, 0, 0]);
}

function serverInit({ width, height }: Size): Buffer {
  const name = Buffer.from("band-e2e");
  const buf = Buffer.alloc(24 + name.length);
  buf.writeUInt16BE(width, 0);
  buf.writeUInt16BE(height, 2);
  buf.writeUInt8(32, 4); // bits per pixel
  buf.writeUInt8(24, 5); // depth
  buf.writeUInt8(0, 6); // little endian
  buf.writeUInt8(1, 7); // true colour
  buf.writeUInt16BE(255, 8);
  buf.writeUInt16BE(255, 10);
  buf.writeUInt16BE(255, 12);
  buf.writeUInt8(16, 14);
  buf.writeUInt8(8, 15);
  buf.writeUInt8(0, 16);
  buf.writeUInt32BE(name.length, 20);
  name.copy(buf, 24);
  return buf;
}

export async function startRfbStub(): Promise<RfbStub> {
  const keys: number[] = [];
  let pointerEvents = 0;
  let size: Size = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const desktop = size;
    let held = Buffer.alloc(0);
    let phase: "version" | "security" | "init" | "messages" = "version";
    let lastUpdate = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fullFrameDue = false;
    socket.on("close", () => clearTimeout(timer));

    // Only a non-incremental request gets the pixels, so a large desktop is sent once rather
    // than every few milliseconds.
    const sendUpdate = () => {
      timer = undefined;
      lastUpdate = Date.now();
      socket.write(fullFrameDue ? frame(desktop) : emptyUpdate());
      fullFrameDue = false;
    };
    const requestUpdate = (incremental: boolean) => {
      if (!incremental) fullFrameDue = true;
      if (timer) return;
      const wait = Math.max(0, lastUpdate + MIN_UPDATE_GAP_MS - Date.now());
      timer = setTimeout(sendUpdate, wait);
    };

    socket.write("RFB 003.008\n");
    socket.on("data", (chunk) => {
      held = Buffer.concat([held, chunk]);
      for (;;) {
        let length: number;
        if (phase === "version") length = 12;
        else if (phase === "security" || phase === "init") length = 1;
        else if (held.length === 0) break;
        else {
          switch (held[0]) {
            case 0:
              length = 20;
              break;
            case 2:
              length = held.length < 4 ? Number.POSITIVE_INFINITY : 4 + 4 * held.readUInt16BE(2);
              break;
            case 3:
              length = 10;
              break;
            case 4:
              length = 8;
              break;
            case 5:
              length = 6;
              break;
            case 6:
              length = held.length < 8 ? Number.POSITIVE_INFINITY : 8 + held.readUInt32BE(4);
              break;
            default:
              socket.destroy();
              return;
          }
        }
        if (held.length < length || held.length === 0) break;
        const message = held.subarray(0, length);
        held = held.subarray(length);
        if (phase === "version") {
          socket.write(Buffer.from([1, 1])); // one security type: None
          phase = "security";
        } else if (phase === "security") {
          socket.write(Buffer.alloc(4)); // SecurityResult OK
          phase = "init";
        } else if (phase === "init") {
          socket.write(serverInit(desktop));
          phase = "messages";
        } else if (message[0] === 3) {
          requestUpdate(message[1] === 1);
        } else if (message[0] === 4 && message[1] === 1) {
          keys.push(message.readUInt32BE(4));
        } else if (message[0] === 5) {
          pointerEvents += 1;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    keys: () => [...keys],
    pointerEvents: () => pointerEvents,
    setSize: (width, height) => {
      size = { width, height };
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
