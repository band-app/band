/**
 * Server-sent events, as far as the MCP proxy needs them: split a byte stream
 * into events, let a callback rewrite the `data` of each, and pass everything
 * else through unchanged. Events are emitted as soon as they complete, so a
 * long stream is never buffered whole. One event larger than `maxEventBytes`
 * ends the stream with an error.
 */

const BOUNDARY = /\r\n\r\n|\n\n|\r\r/;
const LINE_BREAK = /\r\n|\n|\r/;

export class SseEventTooLargeError extends Error {
  constructor() {
    super("An event on the upstream stream was too large to inspect");
    this.name = "SseEventTooLargeError";
  }
}

/**
 * `rewrite` gets an event's data (its `data:` lines joined with newlines) and
 * returns the replacement, or null to leave the event as it came.
 */
export async function* rewriteSse(
  source: AsyncIterable<Uint8Array>,
  rewrite: (data: string) => string | null,
  maxEventBytes: number,
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = BOUNDARY.exec(buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      const event = buffer.slice(0, match.index);
      const boundary = match[0];
      buffer = buffer.slice(end);
      yield encoder.encode(rewriteEvent(event, rewrite) + boundary);
    }
    if (buffer.length > maxEventBytes) throw new SseEventTooLargeError();
  }
  buffer += decoder.decode();
  if (buffer !== "") yield encoder.encode(buffer);
}

function rewriteEvent(event: string, rewrite: (data: string) => string | null): string {
  const lines = event.split(LINE_BREAK);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }
  if (data.length === 0) return event;
  const replacement = rewrite(data.join("\n"));
  if (replacement === null) return event;
  const kept = lines.filter((line) => !line.startsWith("data:"));
  return [...kept, ...replacement.split("\n").map((line) => `data: ${line}`)].join("\n");
}

/** The `data` payloads of every event in a complete SSE body. */
export function sseDataOf(body: string): string[] {
  return body
    .split(BOUNDARY)
    .map((event) =>
      event
        .split(LINE_BREAK)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
        .join("\n"),
    )
    .filter((data) => data !== "");
}
