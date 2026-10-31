/**
 * Length-prefixed messages over a channel's byte stream, for payloads whose
 * boundaries matter (a CDP message is one WebSocket frame). Each message is a
 * 4-byte big-endian length and then that many bytes of UTF-8 text.
 */

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(message: string): Buffer {
  const length = Buffer.byteLength(message, "utf8");
  const out = Buffer.allocUnsafe(4 + length);
  out.writeUInt32BE(length, 0);
  out.write(message, 4, "utf8");
  return out;
}

/** Splits a byte stream back into messages. Throws on a length over {@link MAX_FRAME_BYTES}. */
export async function* decodeFrames(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  // Chunks are joined once per frame, so a large frame arriving in small chunks stays linear.
  let chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    total += chunk.byteLength;
    for (;;) {
      if (total < 4) break;
      let head = chunks[0];
      if (head.length < 4) {
        head = Buffer.concat(chunks);
        chunks = [head];
      }
      const length = head.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) throw new Error(`Frame of ${length} bytes is too large`);
      if (total < 4 + length) break;
      const all = chunks.length === 1 ? head : Buffer.concat(chunks);
      yield all.subarray(4, 4 + length).toString("utf8");
      const rest = all.subarray(4 + length);
      total = rest.length;
      chunks = rest.length > 0 ? [rest] : [];
    }
  }
}

/**
 * Mixed text and binary messages over a channel, for a plugin's live stream. Each message is a
 * 4-byte big-endian length, a kind byte (0 text, 1 bytes) and the payload.
 */
const KIND_TEXT = 0;
const KIND_BYTES = 1;

export function encodeMessageFrame(message: string | Uint8Array): Buffer {
  const body = typeof message === "string" ? Buffer.from(message, "utf8") : message;
  const out = Buffer.allocUnsafe(5 + body.byteLength);
  out.writeUInt32BE(1 + body.byteLength, 0);
  out[4] = typeof message === "string" ? KIND_TEXT : KIND_BYTES;
  out.set(body, 5);
  return out;
}

/** Splits arriving chunks into messages. Throws on a length over {@link MAX_FRAME_BYTES} or a bad kind. */
export class MessageFrameReader {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Array<string | Buffer> {
    this.pending = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const out: Array<string | Buffer> = [];
    for (;;) {
      if (this.pending.length < 4) break;
      const length = this.pending.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES) throw new Error(`Frame of ${length} bytes`);
      if (this.pending.length < 4 + length) break;
      const kind = this.pending[4];
      const body = this.pending.subarray(5, 4 + length);
      if (kind === KIND_TEXT) out.push(body.toString("utf8"));
      else if (kind === KIND_BYTES) out.push(Buffer.from(body));
      else throw new Error(`Unknown frame kind ${kind}`);
      this.pending = this.pending.subarray(4 + length);
    }
    return out;
  }
}
