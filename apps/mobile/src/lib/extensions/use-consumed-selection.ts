import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import type { EditorSelectionInfo } from "./selection";
import { type ConsumedMap, markConsumed, parseConsumed, unconsumed } from "./selection-consumed";
import { useEditorSelection } from "./use-editors";

const KEY = "band.editor-selection-consumed";

// Shared by every composer on the device, so a second chat in the worktree sees the same state.
let current: ConsumedMap = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

function load(): Promise<void> {
  loading ??= AsyncStorage.getItem(KEY).then(
    (raw) => {
      current = { ...parseConsumed(raw, Date.now()), ...current };
      loaded = true;
      notify();
    },
    () => {
      loaded = true;
      notify();
    },
  );
  return loading;
}

/** The worktree's selection unless it was sent or dismissed; `consume` marks it used. */
export function useUnconsumedEditorSelection(worktreeId: string): {
  selection: EditorSelectionInfo | null;
  consume: (info: EditorSelectionInfo) => void;
} {
  const selection = useEditorSelection(worktreeId);
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void load();
    return () => {
      listeners.delete(l);
    };
  }, []);
  const consume = useCallback(
    (info: EditorSelectionInfo) => {
      current = markConsumed(current, worktreeId, info, Date.now());
      notify();
      void AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {});
    },
    [worktreeId],
  );
  // Until the stored state is read, no chip: a sent selection must not flash back.
  return { selection: loaded ? unconsumed(current, worktreeId, selection) : null, consume };
}
