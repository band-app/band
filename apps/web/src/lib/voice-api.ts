import { hubFetch } from "./hub-config";

/** Sends a recorded clip to the hub and returns the text. Throws an `Error` with the hub's message. */
export async function transcribeClip(clip: Blob): Promise<string> {
  const res = await hubFetch("/api/voice/transcribe", {
    method: "POST",
    headers: { "Content-Type": clip.type || "audio/webm" },
    body: clip,
  });
  const body = (await res.json().catch(() => ({}))) as {
    text?: string;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(body.error?.message ?? `Transcription failed (HTTP ${res.status}).`);
  return body.text ?? "";
}
