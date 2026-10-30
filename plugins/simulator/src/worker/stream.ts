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
 * JSON: `touch` (phase and 0..1 coordinates), `button`, `key` and `text`.
 */
export function openScreenStream(
  helper: Helper,
  helpers: ServeSimHelpers,
  info: { width: number; height: number; udid: string; name: string },
): PluginStream {
  const abort = new AbortController();
  const latest = new Latest<Buffer>();
  const hid = openHid(helper);

  void (async () => {
    try {
      const res = await fetch(helper.streamUrl, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`serve-sim stream answered ${res.status}`);
      for await (const frame of mjpegFrames(res.body as unknown as AsyncIterable<Uint8Array>)) {
        latest.push(frame);
      }
    } catch {
      // Ending the output closes the viewer's socket; it reconnects.
    } finally {
      latest.end();
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
      latest.end();
    },
  };
}
