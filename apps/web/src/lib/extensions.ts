/**
 * The editor extensions installed on the hub (`extensions.list`) and the choice of editor for a
 * file. An editor is named `<extensionId>/<editorId>`; `builtin` is the code viewer. A file's
 * choice is the "editor" field of its `band-tab-state:<ws>` entry (set by "Open With…"), else a
 * default a person set for a file name glob (`band:extension-defaults`), else the first editor a
 * manifest marks `default` whose selector matches.
 */
import {
  type ExtensionManifest,
  type FileEditorManifest,
  matchesSelector,
} from "@band-app/plugin-api";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { clientStorage, subscribeClientState } from "./client-state";
import { trpc } from "./trpc-client";

export const EXTENSIONS_QUERY_KEY = ["extensions.list"] as const;
export const BUILTIN_EDITOR = "builtin";
const DEFAULTS_KEY = "band:extension-defaults";
const DEFAULTS_EVENT = "band:extension-defaults-changed";

export interface ExtensionList {
  extensions: ExtensionManifest[];
  errors: { folder: string; error: string }[];
  /** The hub runs with `BAND_MODS=off`. */
  modsOff?: boolean;
  /** How each installed extension got here. */
  sources?: { id: string; official: boolean; source: "official" | "url" | "file" | "unknown" }[];
}

export const EXTENSION_CATALOG_QUERY_KEY = ["extensions.catalog"] as const;

export interface CatalogEntryView {
  id: string;
  name: string;
  description: string;
  version: string;
  minBand: string;
  worker: boolean;
  requires: string[];
  installed: string | null;
  updateAvailable: boolean;
  compatible: boolean;
}

export function useExtensionCatalog(): {
  catalog: { available: boolean; entries: CatalogEntryView[] } | null;
} {
  const query = useQuery({
    queryKey: EXTENSION_CATALOG_QUERY_KEY,
    queryFn: async () =>
      (await trpc.extensions.catalog.query()) as {
        available: boolean;
        entries: CatalogEntryView[];
      },
    staleTime: 30_000,
  });
  return { catalog: query.data ?? null };
}

export interface ResolvedEditor {
  extensionId: string;
  extensionName: string;
  editor: FileEditorManifest;
}

export function useExtensions(): { list: ExtensionList | null; loading: boolean } {
  const query = useQuery({
    queryKey: EXTENSIONS_QUERY_KEY,
    queryFn: async () => {
      return (await trpc.extensions.list.query()) as ExtensionList;
    },
    staleTime: 30_000,
  });
  return { list: query.data ?? null, loading: query.isPending };
}

export const editorRef = (extensionId: string, editorId: string): string =>
  `${extensionId}/${editorId}`;

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function findEditor(list: ExtensionList | null, ref: string): ResolvedEditor | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const extensionId = ref.slice(0, slash);
  const editorId = ref.slice(slash + 1);
  const extension = list?.extensions.find((e) => e.id === extensionId);
  const editor = extension?.contributes.fileEditors.find((e) => e.id === editorId);
  return extension && editor ? { extensionId, extensionName: extension.name, editor } : null;
}

/** Every editor whose selector matches the file, in install order. */
export function editorsForFile(list: ExtensionList | null, path: string): ResolvedEditor[] {
  const name = fileName(path);
  const out: ResolvedEditor[] = [];
  for (const extension of list?.extensions ?? []) {
    for (const editor of extension.contributes.fileEditors) {
      if (editor.selector.some((s) => matchesSelector(s, name))) {
        out.push({ extensionId: extension.id, extensionName: extension.name, editor });
      }
    }
  }
  return out;
}

export function readDefaults(): Record<string, string> {
  try {
    const raw = clientStorage.getItem(DEFAULTS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The glob "Set as default" stores for a file: `*.xlsx`, or the whole name when it has no extension. */
export function defaultGlobFor(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `*${name.slice(dot)}` : name;
}

/** Sets the default editor for a glob, or clears it with `null`. */
export function setDefaultForGlob(glob: string, ref: string | null): void {
  const next = { ...readDefaults() };
  if (ref === null) delete next[glob];
  else next[glob] = ref;
  clientStorage.setItem(DEFAULTS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(DEFAULTS_EVENT));
}

export function setDefaultEditor(path: string, ref: string): void {
  setDefaultForGlob(defaultGlobFor(path), ref);
}

/**
 * The extension editor to use for a file, or null for the built-in viewer. A choice that names
 * an editor that is no longer installed falls back to the built-in viewer.
 */
export function resolveEditor(
  list: ExtensionList | null,
  path: string,
  choice: string | undefined,
  defaults: Record<string, string> = readDefaults(),
): ResolvedEditor | null {
  if (choice === BUILTIN_EDITOR) return null;
  if (choice) return findEditor(list, choice);
  const name = fileName(path);
  for (const [glob, ref] of Object.entries(defaults)) {
    if (!matchesSelector(glob, name)) continue;
    return ref === BUILTIN_EDITOR ? null : findEditor(list, ref);
  }
  return editorsForFile(list, path).find((e) => e.editor.default) ?? null;
}

export function useExtensionDefaults(): Record<string, string> {
  const [defaults, setDefaults] = useState(readDefaults);
  useEffect(() => {
    const refresh = () => setDefaults(readDefaults());
    window.addEventListener(DEFAULTS_EVENT, refresh);
    const off = subscribeClientState((change) => {
      if (change.key === DEFAULTS_KEY) refresh();
    });
    return () => {
      window.removeEventListener(DEFAULTS_EVENT, refresh);
      off();
    };
  }, []);
  return defaults;
}

// --- The editor chosen for one file (`band-tab-state:<ws>`, the "editor" field) ---

const tabStateKey = (ws: string): string => `band-tab-state:${ws}`;

export function getFileEditorChoice(ws: string, path: string): string | undefined {
  try {
    const parsed = JSON.parse(clientStorage.getItem(tabStateKey(ws)) ?? "{}");
    const value = parsed?.[path]?.editor;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function setFileEditorChoice(ws: string, path: string, ref: string | null): void {
  let states: Record<string, Record<string, unknown>> = {};
  try {
    states = JSON.parse(clientStorage.getItem(tabStateKey(ws)) ?? "{}") ?? {};
  } catch {
    states = {};
  }
  const entry = { ...(states[path] ?? {}) };
  if (ref === null) delete entry.editor;
  else entry.editor = ref;
  states[path] = entry;
  clientStorage.setItem(tabStateKey(ws), JSON.stringify(states));
  window.dispatchEvent(new CustomEvent("band:file-editor-choice", { detail: { ws, path } }));
}

/** The editor choice stored for a file, following "Open With…" and changes from other devices. */
export function useFileEditorChoice(ws: string, path: string): string | undefined {
  const [choice, setChoice] = useState(() => getFileEditorChoice(ws, path));
  useEffect(() => {
    const refresh = () => setChoice(getFileEditorChoice(ws, path));
    refresh();
    const onLocal = (e: Event) => {
      const detail = (e as CustomEvent).detail as { ws?: string; path?: string } | undefined;
      if (detail?.ws === ws && detail.path === path) refresh();
    };
    window.addEventListener("band:file-editor-choice", onLocal);
    const off = subscribeClientState((change) => {
      if (change.key === tabStateKey(ws)) refresh();
    });
    return () => {
      window.removeEventListener("band:file-editor-choice", onLocal);
      off();
    };
  }, [ws, path]);
  return choice;
}

// --- Unsaved edits inside an extension's frame (kept on this page, never synced) ---

const dirtyFiles = new Set<string>();
const dirtyKey = (ws: string, path: string): string => `${ws}\u0000${path}`;

export function isExtensionDirty(ws: string, path: string): boolean {
  return dirtyFiles.has(dirtyKey(ws, path));
}

export function setExtensionDirty(ws: string, path: string, dirty: boolean): void {
  const had = dirtyFiles.has(dirtyKey(ws, path));
  if (dirty) dirtyFiles.add(dirtyKey(ws, path));
  else dirtyFiles.delete(dirtyKey(ws, path));
  if (had !== dirty) window.dispatchEvent(new CustomEvent("band:dirty-change"));
}

/** What "Open With…" lists for a file: the matching editors, then the built-in viewer. */
export interface OpenWithOption {
  ref: string;
  label: string;
}

export function openWithOptions(list: ExtensionList | null, path: string): OpenWithOption[] {
  const options = editorsForFile(list, path).map((e) => ({
    ref: editorRef(e.extensionId, e.editor.id),
    label: e.editor.label,
  }));
  return options.length > 0 ? [...options, { ref: BUILTIN_EDITOR, label: "Built-in viewer" }] : [];
}
