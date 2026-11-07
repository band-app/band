/**
 * The selection the person made in an extension editor tab (`editors.selection`), for the chat
 * composer's chip, and the text block a message carries when the chip is kept.
 */
import { selectionBlockText, selectionLabel } from "@band-app/shared/editor-selection-block";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { useAdapter } from "../dashboard/context";
import { queryClient } from "../dashboard/query-client";
import { trpc } from "./trpc-client";

export interface EditorSelectionState {
  file: string;
  extensionId: string;
  editorId: string;
  selection: {
    address: string;
    kind: string;
    label: string;
    text?: string;
  };
  updatedAt: number;
}

const selectionKey = (worktreeId: string) => ["editors.selection", worktreeId] as const;

/** The worktree's latest editor selection. Refetches when the hub says it changed. */
export function useEditorSelection(worktreeId: string): EditorSelectionState | null {
  const adapter = useAdapter();
  useEffect(
    () =>
      adapter.subscribeStatusEvents((event) => {
        if (event.kind === "editor-selection-changed" && event.worktreeId === worktreeId) {
          void queryClient.invalidateQueries({ queryKey: selectionKey(worktreeId) });
        }
      }),
    [adapter, worktreeId],
  );
  const query = useQuery({
    queryKey: selectionKey(worktreeId),
    queryFn: async () =>
      (await trpc.editors.selection.query({ worktreeId })) as EditorSelectionState | null,
    staleTime: 30_000,
  });
  return query.data ?? null;
}

/** The chip's text: "<label> · <file name>". */
export function selectionChipLabel(state: EditorSelectionState): string {
  return selectionLabel(state.file, state.selection.label);
}

/** The block appended after the person's text, as the editor protocol contract defines it. */
export function selectionMessageBlock(state: EditorSelectionState): string {
  return selectionBlockText(state);
}

/** The message text with the selection block after it, separated by a blank line. */
export function withSelectionBlock(text: string, state: EditorSelectionState | null): string {
  return state ? `${text}\n\n${selectionMessageBlock(state)}` : text;
}

// A selection is attached to one message at most. The stamp of the last selection that was sent
// or dismissed is kept per worktree on this device (not synced), so a reload or another chat in
// the worktree does not offer it again. A new selection has a new stamp.
const CONSUMED_TTL_MS = 30 * 60 * 1000;
const consumedKey = (worktreeId: string) => `band:editor-selection-consumed:${worktreeId}`;
const consumedListeners = new Set<() => void>();

function readConsumed(worktreeId: string): number | null {
  try {
    const raw = localStorage.getItem(consumedKey(worktreeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { stamp?: unknown; at?: unknown };
    if (typeof parsed.stamp !== "number" || typeof parsed.at !== "number") return null;
    return Date.now() - parsed.at > CONSUMED_TTL_MS ? null : parsed.stamp;
  } catch {
    return null;
  }
}

/** Remember that this selection was sent or dismissed. */
export function markSelectionConsumed(worktreeId: string, state: EditorSelectionState): void {
  try {
    localStorage.setItem(
      consumedKey(worktreeId),
      JSON.stringify({ stamp: state.updatedAt, at: Date.now() }),
    );
  } catch {
    // Storage unavailable: the selection comes back after a reload, nothing worse.
  }
  for (const listener of consumedListeners) listener();
}

/** The worktree's selection unless it was already sent or dismissed. */
export function useUnconsumedEditorSelection(worktreeId: string): EditorSelectionState | null {
  const selection = useEditorSelection(worktreeId);
  const consumed = useSyncExternalStore(
    (listener) => {
      consumedListeners.add(listener);
      return () => consumedListeners.delete(listener);
    },
    () => readConsumed(worktreeId),
  );
  return selection && selection.updatedAt !== consumed ? selection : null;
}
