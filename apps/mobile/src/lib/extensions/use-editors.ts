import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useHubSession } from "../hub-session";
import {
  DEFAULTS_KEY,
  type ExtensionListLike,
  parseDefaults,
  parseFileChoice,
  type ResolvedEditor,
  resolveEditor,
  tabStateKey,
  withFileChoice,
} from "./editors";
import type { EditorSelectionInfo } from "./selection";

/** The editors procedures of the hub. Typed here so the app builds before the router has them. */
interface EditorsClient {
  extensions: { list: { query(): Promise<ExtensionListLike> } };
  editors: {
    selection: { query(input: { worktreeId: string }): Promise<EditorSelectionInfo | null> };
  };
}

const EXTENSIONS_KEY = ["extensions.list"] as const;

/** Re-reads a synced client-state key when it changes, on this device or another. */
function useClientStateValue(key: string): string | null {
  const { clientState, clientStateReady } = useHubSession();
  const [value, setValue] = useState<string | null>(() => clientState.getItem(key) ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clientStateReady re-reads the saved copy once it is loaded
  useEffect(() => {
    setValue(clientState.getItem(key) ?? null);
    return clientState.subscribe((change) => {
      if (change.key === key) setValue(clientState.getItem(key) ?? null);
    });
  }, [clientState, key, clientStateReady]);
  return value;
}

export interface FileEditor {
  /** Null while the extension list loads. */
  resolved: ResolvedEditor | null;
  loading: boolean;
  choice: string | undefined;
  options: ExtensionListLike | null;
  choose(ref: string | null): void;
}

/** The editor for one file and a way to pick another ("Open with"). */
export function useFileEditor(worktreeId: string, path: string): FileEditor {
  const { client, clientState } = useHubSession();
  const list = useQuery({
    queryKey: EXTENSIONS_KEY,
    queryFn: () => (client as unknown as EditorsClient).extensions.list.query(),
    staleTime: 30_000,
  });
  useClientStateValue(tabStateKey(worktreeId));
  // A local write does not notify subscribers, so `choose` bumps this to read the store again.
  const [, bump] = useState(0);
  const tabState = clientState.getItem(tabStateKey(worktreeId)) ?? null;
  const defaultsRaw = useClientStateValue(DEFAULTS_KEY);
  const choice = parseFileChoice(tabState, path);
  const resolved = useMemo(
    () => resolveEditor(list.data ?? null, path, choice, parseDefaults(defaultsRaw)),
    [list.data, path, choice, defaultsRaw],
  );
  const choose = useCallback(
    (ref: string | null) => {
      const key = tabStateKey(worktreeId);
      clientState.setItem(key, withFileChoice(clientState.getItem(key), path, ref));
      bump((n) => n + 1);
    },
    [clientState, worktreeId, path],
  );
  return { resolved, loading: list.isPending, choice, options: list.data ?? null, choose };
}

/** The worktree's current editor selection, refreshed on `editor-selection-changed`. */
export function useEditorSelection(worktreeId: string): EditorSelectionInfo | null {
  const { client, feed } = useHubSession();
  const queryClient = useQueryClient();
  const queryKey = ["editors.selection", worktreeId];
  const query = useQuery({
    queryKey,
    queryFn: () => (client as unknown as EditorsClient).editors.selection.query({ worktreeId }),
    // An older hub has no editors router; a failed read just means no chip.
    retry: false,
  });
  // Coming back from the editor screen: read it again, whatever events were missed meanwhile.
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey is derived from worktreeId
  useEffect(
    () =>
      feed.onEvent((event) => {
        if (event.kind === "editor-selection-changed" && event.worktreeId === worktreeId) {
          void queryClient.invalidateQueries({ queryKey });
        }
      }),
    [feed, queryClient, worktreeId],
  );
  return query.data ?? null;
}
