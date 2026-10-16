/**
 * Dictation recording in the browser, desktop app and mobile Safari: `getUserMedia` plus
 * `MediaRecorder`, in the first container the browser supports (webm/opus on Chrome and
 * Electron, mp4/aac on Safari). The clip goes to the hub, which sends it to the speech-to-text
 * endpoint. Microphone permission is asked on the first
 * `startRecording()` call, which the mic button's click makes, never earlier.
 */

import { isDesktop } from "./is-desktop";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

/** The first container this browser can record, or undefined when it can record none. */
export function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Whether the mic button can work here. `mediaDevices` is missing on a page that is not a
 * secure context, such as a hub on a LAN address over plain http.
 */
export function voiceRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    pickRecorderMimeType() !== undefined
  );
}

export type MicErrorKind = "denied" | "no-device" | "busy" | "failed";

export class MicError extends Error {
  constructor(
    readonly kind: MicErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MicError";
  }
}

export interface MicPlatform {
  userAgent: string;
  maxTouchPoints: number;
  desktopApp: boolean;
}

const BLOCKED = "Microphone access is blocked.";

/** The "blocked" text for the shell and platform the page runs in. */
export function micBlockedMessageFor({
  userAgent,
  maxTouchPoints,
  desktopApp,
}: MicPlatform): string {
  if (desktopApp) {
    return `${BLOCKED} Allow Band in System Settings > Privacy & Security > Microphone, then tap the mic again.`;
  }
  // iPadOS Safari reports a Mac user agent, so touch support tells it apart.
  const ios =
    /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  if (ios) {
    return `${BLOCKED} Allow it for this site from the address bar's site settings, and check Settings > your browser app > Microphone. Then tap the mic again.`;
  }
  if (/Android/.test(userAgent)) {
    return `${BLOCKED} Tap the lock icon in the address bar > Permissions > Microphone and allow it. Then tap the mic again.`;
  }
  return `${BLOCKED} Allow the microphone for this site in your browser's settings (the lock icon in the address bar), then tap the mic again.`;
}

function micBlockedMessage(): string {
  return micBlockedMessageFor({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    desktopApp: isDesktop,
  });
}

export function describeMicError(err: unknown): MicError {
  if (err instanceof MicError) return err;
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new MicError("denied", micBlockedMessage());
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new MicError("no-device", "No microphone was found on this device.");
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return new MicError("busy", "The microphone is in use by another app. Close it and try again.");
  }
  return new MicError("failed", "Could not start recording.");
}

export interface Recording {
  /** The container the recorder produced, such as `audio/webm;codecs=opus`. */
  mimeType: string;
  /** Stops recording, releases the microphone and resolves with the clip. */
  stop(): Promise<Blob>;
  /** Stops and discards the audio. */
  cancel(): void;
}

export async function startRecording(): Promise<Recording> {
  const mimeType = pickRecorderMimeType();
  if (!mimeType || !navigator.mediaDevices?.getUserMedia) {
    throw new MicError("failed", "This browser cannot record audio.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw describeMicError(err);
  }
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (err) {
    release();
    throw describeMicError(err);
  }
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  });
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  recorder.start();

  const finish = async () => {
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    release();
  };
  return {
    mimeType,
    stop: async () => {
      await finish();
      return new Blob(chunks, { type: mimeType });
    },
    cancel: () => {
      void finish();
    },
  };
}
