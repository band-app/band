/**
 * Dictation for the composer, apart from React Native: a small state machine over a recorder
 * port, and the upload of the clip to the hub (`POST /api/voice/transcribe`). The hub sends it to
 * the speech-to-text endpoint set up in Settings > Voice, and the key never reaches the phone.
 * `use-dictation.ts` wires the port to `expo-audio`; the tests give it a fake one.
 */

import { MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS } from "@band-app/shared/speech-transcription";

export { MAX_AUDIO_SECONDS };

export const MIC_DENIED_MESSAGE =
  "Microphone access is off for Band. Turn it on in Settings > Band > Microphone, then tap the mic again.";

export interface RecorderPort {
  /** Asks iOS for microphone access. The system prompt shows the first time only. */
  requestPermission(): Promise<{ granted: boolean }>;
  start(): Promise<void>;
  /** Stops and returns the recorded file, or null when nothing was recorded. */
  stop(): Promise<{ uri: string } | null>;
  /** Stops and drops the recording. */
  cancel(): Promise<void>;
}

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

export interface DictationState {
  phase: DictationPhase;
  error: string | null;
}

/** The MIME type of a recorded file, from its extension. `expo-audio` records `.m4a` on iOS. */
export function mimeTypeForUri(uri: string): string {
  const ext = uri.split("?")[0]?.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "m4a":
    case "mp4":
    case "aac":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "webm":
      return "audio/webm";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "mp3":
      return "audio/mpeg";
    default:
      return "audio/mp4";
  }
}

export interface UploadOptions {
  hubUrl: string;
  token: string;
  uri: string;
  /** Reads the recorded file. React Native's `fetch(uri)` does it for a `file://` URI. */
  readClip?: (uri: string) => Promise<Blob>;
  fetchImpl?: typeof fetch;
}

const readFile = async (uri: string): Promise<Blob> => (await fetch(uri)).blob();

/** Sends one clip to the hub and returns the text. Throws an `Error` with the hub's message. */
export async function uploadClip(opts: UploadOptions): Promise<string> {
  const clip = await (opts.readClip ?? readFile)(opts.uri);
  if (clip.size === 0) throw new Error("The recording is empty.");
  if (clip.size > MAX_AUDIO_BYTES) throw new Error("The recording is over 25 MB.");
  const send = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await send(`${opts.hubUrl}/api/voice/transcribe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": mimeTypeForUri(opts.uri),
        // Keeps iOS's URL cache from writing the Authorization header to disk.
        "Cache-Control": "no-store",
      },
      body: clip,
    });
  } catch {
    throw new Error("Could not reach the hub.");
  }
  const body = (await res.json().catch(() => ({}))) as {
    text?: string;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(body.error?.message ?? `Transcription failed (HTTP ${res.status}).`);
  return body.text ?? "";
}

/**
 * Tap to start, tap to stop. `stop()` resolves with the text to insert (empty when none was
 * recognized, and `state.error` says so); `cancel()` discards the audio and sends nothing.
 */
export class Dictation {
  private current: DictationState = { phase: "idle", error: null };
  private generation = 0;
  private readonly recorder: RecorderPort;
  private readonly transcribe: (uri: string) => Promise<string>;
  private readonly onChange: (state: DictationState) => void;

  // Plain fields, because Node's type stripping (the unit tests) rejects parameter properties.
  constructor(
    recorder: RecorderPort,
    transcribe: (uri: string) => Promise<string>,
    onChange: (state: DictationState) => void = () => undefined,
  ) {
    this.recorder = recorder;
    this.transcribe = transcribe;
    this.onChange = onChange;
  }

  get state(): DictationState {
    return this.current;
  }

  private set(state: DictationState): void {
    this.current = state;
    this.onChange(state);
  }

  async start(): Promise<void> {
    if (this.current.phase !== "idle") return;
    const generation = ++this.generation;
    this.set({ phase: "starting", error: null });
    try {
      const { granted } = await this.recorder.requestPermission();
      if (generation !== this.generation) return;
      if (!granted) {
        this.set({ phase: "idle", error: MIC_DENIED_MESSAGE });
        return;
      }
      await this.recorder.start();
      if (generation !== this.generation) {
        await this.recorder.cancel();
        return;
      }
      this.set({ phase: "recording", error: null });
    } catch (err) {
      if (generation !== this.generation) return;
      this.set({
        phase: "idle",
        error: err instanceof Error && err.message ? err.message : "Could not start recording.",
      });
    }
  }

  async stop(): Promise<string> {
    if (this.current.phase !== "recording") return "";
    const generation = ++this.generation;
    this.set({ phase: "transcribing", error: null });
    try {
      const clip = await this.recorder.stop();
      if (!clip) {
        this.set({ phase: "idle", error: "Nothing was recorded." });
        return "";
      }
      const text = (await this.transcribe(clip.uri)).trim();
      if (generation !== this.generation) return "";
      this.set({
        phase: "idle",
        error: text ? null : "No speech was recognized. Try again, closer to the microphone.",
      });
      return text;
    } catch (err) {
      if (generation === this.generation) {
        this.set({
          phase: "idle",
          error: err instanceof Error && err.message ? err.message : "Transcription failed.",
        });
      }
      return "";
    }
  }

  async cancel(): Promise<void> {
    if (this.current.phase === "idle") return;
    this.generation++;
    this.set({ phase: "idle", error: null });
    await this.recorder.cancel().catch(() => undefined);
  }
}
