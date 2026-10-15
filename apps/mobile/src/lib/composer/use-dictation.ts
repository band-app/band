/**
 * The composer's mic: `expo-audio` as the recorder behind `Dictation`, the hub's voice status
 * (the mic shows only once Settings > Voice is set up) and an elapsed-seconds counter that
 * stops the clip at the length limit.
 */

import { useQuery } from "@tanstack/react-query";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHubSession } from "../hub-session";
import {
  Dictation,
  type DictationState,
  MAX_AUDIO_SECONDS,
  type RecorderPort,
  uploadClip,
} from "./dictation";

export interface UseDictation {
  /** The hub has voice set up, so the composer shows the mic. */
  available: boolean;
  state: DictationState;
  elapsed: number;
  toggle: () => void;
  cancel: () => void;
}

/** Turns the recording hook into a `RecorderPort`. */
function useRecorderPort(): RecorderPort {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const ref = useRef(recorder);
  ref.current = recorder;
  return useMemo<RecorderPort>(
    () => ({
      requestPermission: async () => {
        const { granted } = await requestRecordingPermissionsAsync();
        return { granted };
      },
      start: async () => {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await ref.current.prepareToRecordAsync();
        ref.current.record();
      },
      stop: async () => {
        await ref.current.stop();
        await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        const uri = ref.current.uri;
        return uri ? { uri } : null;
      },
      cancel: async () => {
        if (ref.current.isRecording) await ref.current.stop().catch(() => undefined);
        await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      },
    }),
    [],
  );
}

export function useDictation(insert: (text: string) => void): UseDictation {
  const { hub, client } = useHubSession();
  const status = useQuery({
    queryKey: ["voice.status", hub.id],
    queryFn: () => client.voice.status.query(),
    staleTime: 30_000,
  });
  const port = useRecorderPort();
  const [state, setState] = useState<DictationState>({ phase: "idle", error: null });
  const [elapsed, setElapsed] = useState(0);
  const insertRef = useRef(insert);
  insertRef.current = insert;
  const hubRef = useRef(hub);
  hubRef.current = hub;

  const dictation = useMemo(
    () =>
      new Dictation(
        port,
        (uri) => uploadClip({ hubUrl: hubRef.current.url, token: hubRef.current.token, uri }),
        setState,
      ),
    [port],
  );

  const stop = useCallback(async () => {
    const text = await dictation.stop();
    if (text) insertRef.current(text);
  }, [dictation]);

  const toggle = useCallback(() => {
    if (dictation.state.phase === "recording") void stop();
    else void dictation.start();
  }, [dictation, stop]);

  const cancel = useCallback(() => void dictation.cancel(), [dictation]);

  const recording = state.phase === "recording";
  useEffect(() => {
    if (!recording) return;
    const startedAt = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(seconds);
      if (seconds >= (status.data?.maxSeconds ?? MAX_AUDIO_SECONDS)) void stop();
    }, 250);
    return () => clearInterval(id);
  }, [recording, status.data?.maxSeconds, stop]);

  // Leaving the chat drops a recording in progress.
  useEffect(() => () => void dictation.cancel(), [dictation]);

  return { available: status.data?.available === true, state, elapsed, toggle, cancel };
}
