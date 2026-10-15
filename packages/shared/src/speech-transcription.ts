/**
 * The OpenAI-compatible speech-to-text request (`POST <baseUrl>/audio/transcriptions`), shared by
 * the hub (which calls a cloud endpoint itself) and the worker (which calls a local server for
 * the hub). It is pure: it uses only `fetch`, `FormData` and `Blob`.
 *
 * `response_format=json` is always sent, because mlx-audio defaults to `ndjson`. Errors carry a
 * `code` and a message that never holds the API key.
 */

/** OpenAI's own limit, and the cap the hub, the worker and the clients all enforce. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** The longest clip a client records. */
export const MAX_AUDIO_SECONDS = 10 * 60;
/** How long one provider call may take. */
export const TRANSCRIBE_TIMEOUT_MS = 2 * 60 * 1000;
/** How long the hub waits for a worker's answer, a little over the worker's own timeout. */
export const WORKER_TRANSCRIBE_TIMEOUT_MS = TRANSCRIBE_TIMEOUT_MS + 10_000;

export type SpeechErrorCode =
  /** The provider refused the key (401 or 403). */
  | "unauthorized"
  /** No answer: DNS, refused connection, TLS, or a redirect. */
  | "unreachable"
  | "timeout"
  /** The provider answered, but not with a transcription. */
  | "bad_response"
  /** Any other provider status, such as an unknown model or a rejected format. */
  | "provider"
  | "too_large"
  | "not_configured"
  | "host_offline";

export class SpeechError extends Error {
  // A plain field, because Node's type stripping (used by the mobile and shared tests) does not
  // accept constructor parameter properties.
  readonly code: SpeechErrorCode;
  constructor(code: SpeechErrorCode, message: string) {
    super(message);
    this.name = "SpeechError";
    this.code = code;
  }
}

export interface TranscriptionRequest {
  baseUrl: string;
  /** Sent as `Authorization: Bearer`. Local servers usually need none. */
  apiKey?: string;
  model: string;
  /** ISO-639-1 code. With none, the provider detects the language. */
  language?: string;
  audio: Uint8Array;
  /** The MIME type the recorder produced, such as `audio/webm;codecs=opus`. */
  mimeType: string;
  timeoutMs?: number;
}

/** `<baseUrl>/audio/transcriptions`, tolerating a trailing slash. */
export function transcriptionUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/audio/transcriptions`;
}

/** Throws a `SpeechError` unless `value` is an http(s) URL with no credentials. */
export function assertEndpointUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SpeechError("not_configured", "The speech-to-text base URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SpeechError("not_configured", "The speech-to-text base URL must be http or https.");
  }
  if (url.username || url.password) {
    throw new SpeechError("not_configured", "Put the API key in the vault, not in the base URL.");
  }
  return url;
}

const EXTENSIONS: [RegExp, string][] = [
  [/webm/, "webm"],
  [/ogg|opus/, "ogg"],
  [/mp4|m4a|aac|x-m4a/, "m4a"],
  [/mpeg|mp3/, "mp3"],
  [/wav|wave/, "wav"],
  [/flac/, "flac"],
];

/** A file name whose extension matches the MIME type, because providers check it. */
export function audioFileName(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  for (const [pattern, ext] of EXTENSIONS) {
    if (pattern.test(base)) return `audio.${ext}`;
  }
  return "audio.webm";
}

/** The MIME type without parameters (`audio/webm;codecs=opus` becomes `audio/webm`). */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() || "audio/webm";
}

export function buildTranscriptionForm(req: TranscriptionRequest): FormData {
  const form = new FormData();
  const type = baseMimeType(req.mimeType);
  form.append("file", new Blob([req.audio as BlobPart], { type }), audioFileName(req.mimeType));
  form.append("model", req.model);
  form.append("response_format", "json");
  if (req.language) form.append("language", req.language);
  return form;
}

/** Removes the key, and anything shaped like a bearer token, from text that may echo it. */
export function scrubSecrets(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join("[redacted]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  out = out.replace(/\b(sk|gsk|xai|key)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]");
  return out;
}

function providerMessage(body: string, apiKey?: string): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; detail?: unknown };
    const err = parsed.error;
    const text =
      typeof err === "string"
        ? err
        : typeof err?.message === "string"
          ? err.message
          : typeof parsed.detail === "string"
            ? parsed.detail
            : undefined;
    if (text) detail = text;
  } catch {
    // Not JSON: use the raw text.
  }
  return scrubSecrets(detail, apiKey).replace(/\s+/g, " ").slice(0, 300);
}

/**
 * Sends one clip and returns the text. Throws `SpeechError`. `fetchImpl` is for callers that
 * need their own transport; tests use the real one against a stub server.
 */
export async function requestTranscription(
  req: TranscriptionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string }> {
  if (req.audio.byteLength === 0) {
    throw new SpeechError("bad_response", "The recording is empty.");
  }
  if (req.audio.byteLength > MAX_AUDIO_BYTES) {
    throw new SpeechError("too_large", "The recording is over 25 MB.");
  }
  const url = transcriptionUrl(assertEndpointUrl(req.baseUrl).toString());
  const headers: Record<string, string> = {};
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;

  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: buildTranscriptionForm(req),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new SpeechError(
        "timeout",
        `The speech-to-text server did not answer within ${Math.round(timeoutMs / 1000)} s.`,
      );
    }
    const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? "") : "";
    const host = new URL(url).host;
    const detail = scrubSecrets(cause, req.apiKey);
    throw new SpeechError(
      "unreachable",
      `Could not reach ${host}${detail ? ` (${detail})` : ""}. Check the base URL and that the server is running.`,
    );
  }
  try {
    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new SpeechError(
        "unauthorized",
        "The speech-to-text server refused the API key. Check the key in the vault.",
      );
    }
    if (!response.ok) {
      const detail = providerMessage(body, req.apiKey);
      throw new SpeechError(
        "provider",
        `The speech-to-text server answered ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const text = (parsed as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") {
      throw new SpeechError(
        "bad_response",
        "The server did not return a transcription. Check that the base URL ends in /v1 and that the model is a speech-to-text model.",
      );
    }
    return { text: text.trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** A silent 16-bit mono WAV, for the "Test connection" request. */
export function silentWav(seconds = 1, sampleRate = 16000): Uint8Array {
  const samples = Math.round(seconds * sampleRate);
  const dataBytes = samples * 2;
  const buf = new Uint8Array(44 + dataBytes);
  const view = new DataView(buf.buffer);
  const tag = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  return buf;
}

/** What `voice.status` tells every paired device. No URL, model or key. */
export interface VoiceStatus {
  /** Voice is on and complete, so the composer shows a mic. */
  available: boolean;
  /** Why it is not available, for the composer tooltip. */
  reason?: string;
  maxBytes: number;
  maxSeconds: number;
}

/** The hub-wide setting, as stored in `settings.json` under `voice`. */
export interface VoiceSettings {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  language?: string;
  /** A host id: that worker makes the request. Unset means the hub does. */
  hostId?: string;
  /** A vault item (`api_key`) holding the key. */
  apiKeyItemId?: string;
}

export const VOICE_TRANSCRIBE_PATH = "/api/voice/transcribe";
