// The wire protocol between the Band worker and an extension's worker service process.
// Plain JavaScript with no dependencies, so an extension can copy this folder next to its entry.
//
// Control messages are NDJSON on the service's stdin (worker to service) and stdout (service to
// worker). A request is {id, method, params}, its answer {id, result} or {id, error: {message}}.
// A message with no id is a notification. Stream data does not use stdio: it goes over file
// descriptor 3, a pipe the worker opens beside stdio, as binary frames.

/** The file descriptor that carries stream frames. */
export const STREAM_FD = 3;

/** The largest stream frame, text or bytes. */
export const MAX_STREAM_FRAME_BYTES = 16 * 1024 * 1024;

const KIND_TEXT = 0;
const KIND_BYTES = 1;

/**
 * One stream frame: 4-byte big-endian length of what follows, 4-byte stream id, a kind byte
 * (0 text, 1 bytes) and the payload.
 */
export function encodeStreamFrame(streamId, message) {
  const body = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
  const out = Buffer.allocUnsafe(9 + body.length);
  out.writeUInt32BE(5 + body.length, 0);
  out.writeUInt32BE(streamId, 4);
  out[8] = typeof message === "string" ? KIND_TEXT : KIND_BYTES;
  body.copy(out, 9);
  return out;
}

/** Splits arriving chunks into frames. Throws on a bad length or kind. */
export class StreamFrameReader {
  constructor() {
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      if (this.pending.length < 4) break;
      const length = this.pending.readUInt32BE(0);
      if (length < 5 || length > MAX_STREAM_FRAME_BYTES) {
        throw new Error(`Stream frame of ${length} bytes`);
      }
      if (this.pending.length < 4 + length) break;
      const streamId = this.pending.readUInt32BE(4);
      const kind = this.pending[8];
      const body = this.pending.subarray(9, 4 + length);
      if (kind === KIND_TEXT) out.push({ streamId, message: body.toString("utf8") });
      else if (kind === KIND_BYTES) out.push({ streamId, message: Buffer.from(body) });
      else throw new Error(`Unknown stream frame kind ${kind}`);
      this.pending = this.pending.subarray(4 + length);
    }
    return out;
  }
}
