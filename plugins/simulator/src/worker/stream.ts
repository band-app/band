import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginStream } from "@band-app/plugin-api/worker";
import WebSocket from "ws";
import type { Helper, ServeSimHelpers } from "./servesim.ts";

const BUTTONS: Record<string, string> = {
  HOME: "home",
  LOCK: "lock",
  SIDE_BUTTON: "side_button",
  SIRI: "siri",
};
export const BUTTON_NAMES = Object.keys(BUTTONS);

export function serveSimButton(name: string): string {
  const mapped = BUTTONS[name];
  if (!mapped) throw new Error(`button must be one of ${BUTTON_NAMES.join(", ")}`);
  return mapped;
}

const KEY_USAGE: Record<string, number> = { Enter: 0x28, Backspace: 0x2a, Tab: 0x2b, Escape: 0x29 };

const JPEG_START = Buffer.from([0xff, 0xd8]);

/**
 * Splits serve-sim's `multipart/x-mixed-replace` stream into JPEG frames. Each part has
 * a `Content-Length`, so no boundary search is needed.
 */
export async function* mjpegFrames(body: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  let buf = Buffer.alloc(0);
  for await (const chunk of body) {
    buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
    for (;;) {
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd < 0) break;
      const head = buf.subarray(0, headEnd).toString("latin1");
      const length = /content-length:\s*(\d+)/i.exec(head)?.[1];
      if (!length) {
        // A part with no length: skip its header and look again.
        buf = buf.subarray(headEnd + 4);
        continue;
      }
      const size = Number(length);
      const start = headEnd + 4;
      if (buf.length < start + size) break;
      const frame = buf.subarray(start, start + size);
      buf = buf.subarray(start + size);
      if (frame.subarray(0, 2).equals(JPEG_START)) yield Buffer.from(frame);
    }
  }
}

/** Pixel size of a JPEG, from its first start-of-frame marker, or null when it has none. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1] as number;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * What a viewer is sent. The `direct` profile is serve-sim's own frames: the viewer is on this
 * machine, so nothing limits them. The `hub` profile is for a viewer behind the hub, where every
 * frame crosses the link and the hub's connection to the browser. serve-sim has no size or rate
 * option on its MJPEG stream, so the worker halves the frame's width and height and sends at most
 * `HUB_MAX_FPS` frames a second. Touches are fractions of the screen, so scaling does not change
 * where they land.
 */
export const HUB_MAX_FPS = 15;
const HUB_SCALE = 0.5;
const HUB_JPEG_QUALITY = 70;

export function streamProfile(params: unknown): "hub" | "direct" {
  const profile = (params as { profile?: unknown } | null)?.profile;
  return profile === "hub" ? "hub" : "direct";
}

/** Halves a JPEG with `sips`, which ships with macOS (the only system the simulator runs on). */
class FrameScaler {
  private dir: Promise<string> | null = null;
  private disposed = false;

  async scale(frame: Buffer): Promise<Buffer> {
    const size = jpegSize(frame);
    if (!size || this.disposed) return frame;
    const width = Math.max(1, Math.floor(size.width * HUB_SCALE));
    const height = Math.max(1, Math.floor(size.height * HUB_SCALE));
    try {
      this.dir ??= mkdtemp(join(tmpdir(), "band-sim-frame-"));
      const dir = await this.dir;
      const input = join(dir, "in.jpg");
      const output = join(dir, "out.jpg");
      await writeFile(input, frame);
      await new Promise<void>((resolve, reject) =>
        execFile(
          "/usr/bin/sips",
          [
            "-z",
            String(height),
            String(width),
            "-s",
            "formatOptions",
            String(HUB_JPEG_QUALITY),
            input,
            "--out",
            output,
          ],
          { timeout: 5000 },
          (err) => (err ? reject(err) : resolve()),
        ),
      );
      return await readFile(output);
    } catch {
      // The viewer gets the full frame rather than none.
      return frame;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const dir = this.dir ? await this.dir.catch(() => null) : null;
    this.dir = null;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Holds the newest message, so a slow viewer skips frames instead of lagging further behind. */
class Latest<T> {
  private value: T | undefined;
  private waiter: (() => void) | null = null;
  private ended = false;

  push(value: T): void {
    this.value = value;
    this.waiter?.();
  }

  end(): void {
    this.ended = true;
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.value !== undefined) {
        const v = this.value;
        this.value = undefined;
        yield v;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
  }
}

interface Hid {
  send(type: number, payload: unknown): void;
  close(): void;
}

/** The helper's HID socket: a type byte, then JSON. Messages sent before it opens wait. */
function openHid(helper: Helper): Hid {
  const ws = new WebSocket(helper.wsUrl);
  const queue: Buffer[] = [];
  ws.on("open", () => {
    for (const m of queue.splice(0)) ws.send(m);
  });
  ws.on("error", () => undefined);
  return {
    send(type, payload) {
      const msg = Buffer.concat([Buffer.from([type]), Buffer.from(JSON.stringify(payload))]);
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      else if (ws.readyState === WebSocket.CONNECTING) queue.push(msg);
    },
    close: () => ws.close(),
  };
}

const unit = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;

/**
 * The live screen of one device. Messages to the viewer are text `{"type":"info"}` and then one
 * binary JPEG per frame (the newest one when the viewer is slow). Messages from the viewer are
 * JSON: `touch` (phase and 0..1 coordinates), `button`, `key` and `text`. Frame size and rate
 * follow the `profile` in `params`.
 */
export function openScreenStream(
  helper: Helper,
  helpers: ServeSimHelpers,
  info: { width: number; height: number; udid: string; name: string },
  params: unknown = {},
): PluginStream {
  const abort = new AbortController();
  const latest = new Latest<Buffer>();
  const hid = openHid(helper);
  const scaler = streamProfile(params) === "hub" ? new FrameScaler() : null;
  // Raw frames wait here for the scaler, which takes the newest one at most `HUB_MAX_FPS` times a second.
  const raw = scaler ? new Latest<Buffer>() : latest;

  if (scaler) {
    void (async () => {
      const frames = raw[Symbol.asyncIterator]();
      let sentAt = 0;
      try {
        for (;;) {
          const wait = sentAt + 1000 / HUB_MAX_FPS - Date.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          const next = await frames.next();
          if (next.done) break;
          sentAt = Date.now();
          latest.push(await scaler.scale(next.value));
        }
      } finally {
        latest.end();
      }
    })();
  }

  void (async () => {
    try {
      const res = await fetch(helper.streamUrl, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`serve-sim stream answered ${res.status}`);
      for await (const frame of mjpegFrames(res.body as unknown as AsyncIterable<Uint8Array>)) {
        raw.push(frame);
      }
    } catch {
      // Ending the output closes the viewer's socket; it reconnects.
    } finally {
      raw.end();
      if (!scaler) latest.end();
    }
  })();

  let typing: Promise<unknown> = Promise.resolve();
  // The info message goes first and is never coalesced; only frames are.
  const output = (async function* () {
    yield JSON.stringify({ type: "info", ...info });
    yield* latest;
  })();
  let queuedText = 0;
  return {
    output,
    write(message) {
      if (typeof message !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(message) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.type) {
        case "touch": {
          const x = unit(msg.x);
          const y = unit(msg.y);
          if (x === null || y === null) return;
          if (msg.phase !== "begin" && msg.phase !== "move" && msg.phase !== "end") return;
          hid.send(3, { type: msg.phase, x, y, edge: 0 });
          return;
        }
        case "button": {
          if (typeof msg.name !== "string") return;
          const name = BUTTONS[msg.name];
          if (name) hid.send(4, { button: name });
          return;
        }
        case "key": {
          const usage = typeof msg.key === "string" ? KEY_USAGE[msg.key] : undefined;
          if (usage === undefined) return;
          hid.send(6, { type: "down", usage });
          hid.send(6, { type: "up", usage });
          return;
        }
        case "text": {
          const text = msg.text;
          if (typeof text !== "string" || text === "" || text.length > 1000) return;
          // A controlling viewer cannot queue more than a few typed chunks at once.
          if (queuedText >= 20) return;
          queuedText++;
          typing = typing
            .then(() => helpers.type(helper.udid, text))
            .catch(() => undefined)
            .finally(() => queuedText--);
          return;
        }
      }
    },
    close() {
      abort.abort();
      hid.close();
      raw.end();
      latest.end();
      void scaler?.dispose();
    },
  };
}
