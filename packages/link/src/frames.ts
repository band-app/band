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
