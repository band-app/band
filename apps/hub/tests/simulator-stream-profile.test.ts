// What a viewer of the simulator stream is sent. serve-sim is stood in for by an HTTP server that
// streams one real JPEG as `multipart/x-mixed-replace` at 60 frames a second, with a WebSocket
// that records the input it receives. The stream under test is the plugin's real
// `openScreenStream`. It scales with macOS's `sips`, so the test runs only on a Mac.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  HUB_MAX_FPS,
  jpegSize,
  openScreenStream,
} from "../../../plugins/simulator/src/worker/stream";

const CAN_RUN = process.platform === "darwin";
const WIDTH = 400;
const HEIGHT = 800;

/** A gradient PNG, so the JPEG has real content to encode. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = (x * 255) / width;
      raw[i + 1] = (y * 255) / height;
      raw[i + 2] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let dir: string;
let jpeg: Buffer;
let http: Server;
let hid: WebSocketServer;
const input: Array<{ type: number; payload: Record<string, unknown> }> = [];
let helper: { udid: string; port: number; streamUrl: string; wsUrl: string; axUrl: string };

beforeAll(async () => {
  if (!CAN_RUN) return;
  dir = mkdtempSync(join(tmpdir(), "band-sim-profile-"));
  writeFileSync(join(dir, "in.png"), png(WIDTH, HEIGHT));
  execFileSync(
    "/usr/bin/sips",
    ["-s", "format", "jpeg", join(dir, "in.png"), "--out", join(dir, "in.jpg")],
    {
      stdio: "ignore",
    },
  );
  jpeg = readFileSync(join(dir, "in.jpg"));

  http = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame" });
    const timer = setInterval(() => {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write("\r\n");
    }, 1000 / 60);
    req.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  hid = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => hid.once("listening", resolve));
  hid.on("connection", (ws) =>
    ws.on("message", (data: Buffer) =>
      input.push({
        type: data[0] as number,
        payload: JSON.parse(data.subarray(1).toString("utf8")) as Record<string, unknown>,
      }),
    ),
  );
  const httpPort = (http.address() as AddressInfo).port;
  const hidPort = (hid.address() as AddressInfo).port;
  helper = {
    udid: "stand-in",
    port: httpPort,
    streamUrl: `http://127.0.0.1:${httpPort}/stream.mjpeg`,
    wsUrl: `ws://127.0.0.1:${hidPort}`,
    axUrl: `http://127.0.0.1:${httpPort}/ax`,
  };
});

afterAll(async () => {
  if (!CAN_RUN) return;
  hid.close();
  await new Promise((resolve) => http.close(resolve));
  http.closeAllConnections();
  rmSync(dir, { recursive: true, force: true });
});

const helpers = { type: async () => undefined } as never;
const info = { width: 200, height: 400, udid: "stand-in", name: "Stand-in" };

/** Reads frames for `ms` and returns the sizes and how many arrived. */
async function watch(params: unknown, ms: number) {
  const stream = openScreenStream(helper, helpers, info, params);
  const sizes: Array<{ width: number; height: number } | null> = [];
  const deadline = Date.now() + ms;
  const reader = (async () => {
    for await (const message of stream.output) {
      if (typeof message === "string") continue;
      sizes.push(jpegSize(Buffer.from(message)));
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())));
  stream.close();
  await reader;
  return { stream, sizes };
}

describe.skipIf(!CAN_RUN)("the simulator stream's profiles (S3)", () => {
  it("sends a viewer behind the hub frames of half the width and height, at most 15 a second", async () => {
    const { sizes } = await watch({ profile: "hub" }, 3000);
    expect(sizes.length).toBeGreaterThan(3);
    for (const size of sizes) expect(size).toEqual({ width: WIDTH / 2, height: HEIGHT / 2 });
    // 3 s at the cap is 45 frames; the source sends 180.
    expect(sizes.length).toBeLessThanOrEqual(Math.ceil(3 * HUB_MAX_FPS) + 2);
  });

  it("sends a viewer on this computer the full frames, as fast as they come", async () => {
    const { sizes } = await watch({ profile: "direct" }, 1500);
    expect(sizes.length).toBeGreaterThan(1.5 * HUB_MAX_FPS);
    for (const size of sizes) expect(size).toEqual({ width: WIDTH, height: HEIGHT });
  });

  it("passes a touch to the device as the same fractions on either profile", async () => {
    for (const profile of ["hub", "direct"]) {
      input.length = 0;
      const stream = openScreenStream(helper, helpers, info, { profile });
      stream.write(JSON.stringify({ type: "touch", phase: "begin", x: 0.25, y: 0.75 }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      stream.close();
      expect(input, profile).toEqual([
        { type: 3, payload: { type: "begin", x: 0.25, y: 0.75, edge: 0 } },
      ]);
    }
  });
});
