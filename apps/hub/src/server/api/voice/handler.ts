import type { IncomingMessage, ServerResponse } from "node:http";

import { MAX_AUDIO_BYTES, SpeechError } from "@band-app/shared/speech-transcription";

import { voiceService } from "../../services/voice-service";
import { CHAT_ID_HEADER, TERMINAL_ID_HEADER, WORKTREE_ID_HEADER } from "../context";

const STATUS: Record<string, number> = {
  not_configured: 409,
  too_large: 413,
  unauthorized: 502,
  unreachable: 502,
  provider: 502,
  bad_response: 502,
  host_offline: 503,
  timeout: 504,
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * `POST /api/voice/transcribe`: the raw audio clip as the body, its MIME type as `Content-Type`.
 * Answers `{ text }` or `{ error: { code, message } }`. Runs after the device-token check. A
 * request that carries an agent's chat, worktree or terminal header is refused, because an agent
 * must not spend the hub's speech-to-text key (the relay and MCP endpoint leave the route out).
 */
export async function handleVoiceTranscribe(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    send(res, 405, { error: { code: "method", message: "Use POST." } });
    return;
  }
  if (
    req.headers[CHAT_ID_HEADER] ||
    req.headers[WORKTREE_ID_HEADER] ||
    req.headers[TERMINAL_ID_HEADER]
  ) {
    send(res, 403, { error: { code: "forbidden", message: "Agents cannot use dictation." } });
    return;
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    send(res, 413, { error: { code: "too_large", message: "The recording is over 25 MB." } });
    req.resume();
    return;
  }
  const mimeType = String(req.headers["content-type"] ?? "audio/webm");
  const chunks: Buffer[] = [];
  let total = 0;
  let overflowed = false;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > MAX_AUDIO_BYTES) {
          if (!overflowed) {
            overflowed = true;
            chunks.length = 0;
            reject(new SpeechError("too_large", "The recording is over 25 MB."));
            // Drain the rest so the 413 can still be written on this socket.
            req.resume();
          }
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", resolve);
      req.on("error", reject);
    });
    const { text } = await voiceService.transcribe(Buffer.concat(chunks), mimeType);
    send(res, 200, { text });
  } catch (err) {
    if (err instanceof SpeechError) {
      send(res, STATUS[err.code] ?? 502, { error: { code: err.code, message: err.message } });
      return;
    }
    console.error("voice transcribe failed:", err instanceof Error ? err.name : "error");
    send(res, 500, { error: { code: "internal", message: "Transcription failed." } });
  }
}
