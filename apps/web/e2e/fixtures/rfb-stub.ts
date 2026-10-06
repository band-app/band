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

const WIDTH = 64;
const HEIGHT = 48;
const MIN_UPDATE_GAP_MS = 150;

export interface RfbStub {
  port: number;
  /** Keysyms of the KeyEvents received with the down flag, in order. */
  keys(): number[];
  /** Pointer events received. */
  pointerEvents(): number;
  close(): Promise<void>;
}

function frame(): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      // Little-endian 0x00RRGGBB: bytes are B, G, R, pad.
      pixels[i] = 255 - Math.floor((x * 255) / WIDTH);
      pixels[i + 1] = Math.floor((y * 255) / HEIGHT);
      pixels[i + 2] = 200;
      pixels[i + 3] = 0;
    }
  }
  const header = Buffer.alloc(16);
  header.writeUInt8(0, 0); // FramebufferUpdate
  header.writeUInt16BE(1, 2); // one rectangle
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(WIDTH, 8);
  header.writeUInt16BE(HEIGHT, 10);
  header.writeInt32BE(0, 12); // Raw encoding
  return Buffer.concat([header, pixels]);
}

function serverInit(): Buffer {
  const name = Buffer.from("band-e2e");
  const buf = Buffer.alloc(24 + name.length);
  buf.writeUInt16BE(WIDTH, 0);
  buf.writeUInt16BE(HEIGHT, 2);
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
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let held = Buffer.alloc(0);
    let phase: "version" | "security" | "init" | "messages" = "version";
    let lastUpdate = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    socket.on("close", () => clearTimeout(timer));

    const sendUpdate = () => {
      timer = undefined;
      lastUpdate = Date.now();
      socket.write(frame());
    };
    const requestUpdate = () => {
      if (timer) return;
      const wait = Math.max(0, lastUpdate + MIN_UPDATE_GAP_MS - Date.now());
      timer = setTimeout(sendUpdate, wait);
    };

    socket.write("RFB 003.008\n");
    socket.on("data", (chunk) => {
      held = Buffer.concat([held, chunk]);
      for (;;) {
        let size: number;
        if (phase === "version") size = 12;
        else if (phase === "security" || phase === "init") size = 1;
        else if (held.length === 0) break;
        else {
          switch (held[0]) {
            case 0:
              size = 20;
              break;
            case 2:
              size = held.length < 4 ? Number.POSITIVE_INFINITY : 4 + 4 * held.readUInt16BE(2);
              break;
            case 3:
              size = 10;
              break;
            case 4:
              size = 8;
              break;
            case 5:
              size = 6;
              break;
            case 6:
              size = held.length < 8 ? Number.POSITIVE_INFINITY : 8 + held.readUInt32BE(4);
              break;
            default:
              socket.destroy();
              return;
          }
        }
        if (held.length < size || held.length === 0) break;
        const message = held.subarray(0, size);
        held = held.subarray(size);
        if (phase === "version") {
          socket.write(Buffer.from([1, 1])); // one security type: None
          phase = "security";
        } else if (phase === "security") {
          socket.write(Buffer.alloc(4)); // SecurityResult OK
          phase = "init";
        } else if (phase === "init") {
          socket.write(serverInit());
          phase = "messages";
        } else if (message[0] === 3) {
          requestUpdate();
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
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
