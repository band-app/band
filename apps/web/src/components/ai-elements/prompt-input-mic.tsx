import { insertAtSelection } from "@band-app/shared/dictation-text";
import { cn } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Mic, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { transcribeClip } from "../../lib/voice-api";
import {
  describeMicError,
  type Recording,
  startRecording,
  voiceRecordingSupported,
} from "../../lib/voice-recorder";
import { usePromptInputContext } from "./prompt-input";

export const VOICE_STATUS_KEY = ["voice.status"] as const;

type Phase = "idle" | "starting" | "recording" | "transcribing";

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Mic button for the composer. Tap to record, tap again to stop. The
 * clip goes to the hub, and the text lands at the cursor for the user to edit. It never sends
 * the message. Hidden until the hub has voice set up and this browser can record.
 */
export function PromptInputMic({ className }: { className?: string }) {
  const { textareaRef, setNotice } = usePromptInputContext();
  const status = useQuery({
    queryKey: VOICE_STATUS_KEY,
    queryFn: () => trpc.voice.status.query(),
    staleTime: 30_000,
  });
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recordingRef = useRef<Recording | null>(null);
  const mountedRef = useRef(true);
  const maxSeconds = status.data?.maxSeconds ?? 600;

  const insert = useCallback(
    (text: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      const next = insertAtSelection(textarea.value, start, end, text);
      // The native setter plus an input event keeps React's draft state in step.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        next.value,
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = next.caret;
    },
    [textareaRef],
  );

  const stop = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    setPhase("transcribing");
    try {
      const clip = await recording.stop();
      const text = await transcribeClip(clip);
      if (text) insert(text);
      else setNotice("No speech was recognized. Try again, closer to the microphone.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Transcription failed.");
    } finally {
      setPhase("idle");
    }
  }, [insert, setNotice]);

  const cancel = useCallback(() => {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setPhase("idle");
  }, []);

  const start = useCallback(async () => {
    setNotice(null);
    setPhase("starting");
    try {
      const recording = await startRecording();
      if (!mountedRef.current) {
        recording.cancel();
        return;
      }
      recordingRef.current = recording;
      setElapsed(0);
      setPhase("recording");
    } catch (err) {
      setNotice(describeMicError(err).message);
      setPhase("idle");
    }
  }, [setNotice]);

  // The timer, and the auto-stop at the clip length limit.
  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(seconds);
      if (seconds >= maxSeconds) void stop();
    }, 250);
    return () => window.clearInterval(id);
  }, [phase, maxSeconds, stop]);

  // Leaving the chat releases the microphone and drops the clip.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setNotice(null);
      recordingRef.current?.cancel();
      recordingRef.current = null;
    };
  }, [setNotice]);

  if (!status.data?.available || !voiceRecordingSupported()) return null;

  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "transcribing";
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <button
        type="button"
        data-testid="prompt-input__mic"
        data-phase={phase}
        aria-label={recording ? "Stop and transcribe" : "Dictate"}
        aria-pressed={recording}
        disabled={busy}
        onClick={() => (recording ? void stop() : void start())}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60",
          recording && "bg-destructive/10 text-destructive hover:bg-destructive/20",
          className,
        )}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : recording ? (
          <Square className="size-4 fill-current" />
        ) : (
          <Mic className="size-4" />
        )}
      </button>
      {recording ? (
        <div
          data-testid="prompt-input__mic-listening"
          className="flex items-center gap-1.5 pl-1 text-xs text-muted-foreground"
        >
          <span className="size-2 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
          <span>Listening</span>
          <span data-testid="prompt-input__mic-timer" className="tabular-nums">
            {formatElapsed(elapsed)}
          </span>
          <button
            type="button"
            data-testid="prompt-input__mic-cancel"
            aria-label="Cancel dictation"
            onClick={cancel}
            className="inline-flex items-center justify-center rounded-md p-1 hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {phase === "transcribing" ? (
        <span className="pl-1 text-xs text-muted-foreground">Transcribing</span>
      ) : null}
    </div>
  );
}
