import type { LinkSession } from "./session.ts";

/** Largest JSON value sent inside a message. A link message may not exceed 1 MiB. */
export const PAYLOAD_INLINE_LIMIT = 256 * 1024;

/**
 * A JSON value in a request or a reply, either side of the link. A small one
 * travels in the message. A large one goes down a channel the sender opens
 * first, so the channel is open when the receiver reads `chan`.
 */
export type JsonPayload = { json: unknown } | { chan: number };

export function sendPayload(session: LinkSession, value: unknown): JsonPayload {
  const text = JSON.stringify(value ?? null);
  if (Buffer.byteLength(text) <= PAYLOAD_INLINE_LIMIT) return { json: value ?? null };
  const ch = session.openChannel("payload");
  ch.discardIncoming();
  ch.send(Buffer.from(text)).then(
    () => ch.end(),
    () => undefined,
  );
  return { chan: ch.id };
}

/** Reads a payload {@link sendPayload} made, from the message or to the channel's end. */
export async function readPayload<T>(session: LinkSession, payload: JsonPayload): Promise<T> {
  if ("json" in payload) return payload.json as T;
  const ch = session.getChannel(payload.chan);
  if (!ch) throw new Error(`payload channel ${payload.chan} is not open`);
  const data = await ch.readAll();
  ch.end();
  return JSON.parse(data.toString()) as T;
}
