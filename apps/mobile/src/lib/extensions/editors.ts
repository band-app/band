/**
 * Which editor opens a file. The rules match the web app (`apps/web/src/lib/extensions.ts`): a
 * file's own choice (the `editor` field of its `band-tab-state:<worktree>` entry), then the
 * default a person set for a file name glob (`band:extension-defaults`), then the first editor
 * a manifest marks `default` whose selector matches. `builtin` is the code viewer.
 */

export const BUILTIN_EDITOR = "builtin";
export const DEFAULTS_KEY = "band:extension-defaults";
export const tabStateKey = (worktreeId: string) => `band-tab-state:${worktreeId}`;

export interface FileEditorLike {
  id: string;
  label: string;
  selector: string[];
  default?: boolean;
}

export interface ExtensionLike {
  id: string;
  name: string;
  contributes: { fileEditors: FileEditorLike[] };
}

export interface ExtensionListLike {
  extensions: ExtensionLike[];
}

export interface ResolvedEditor {
  extensionId: string;
  extensionName: string;
  editor: FileEditorLike;
}

export const editorRef = (extensionId: string, editorId: string) => `${extensionId}/${editorId}`;

/** A glob with `*` and `?`, matched against a file name, case-insensitively. */
export function matchesSelector(selector: string, fileName: string): boolean {
  const pattern = selector
    .replace(/[.+^${}()|[\]\\@-]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`, "i").test(fileName);
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function findEditor(list: ExtensionListLike | null, ref: string): ResolvedEditor | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const extension = list?.extensions.find((e) => e.id === ref.slice(0, slash));
  const editor = extension?.contributes.fileEditors.find((e) => e.id === ref.slice(slash + 1));
  return extension && editor
    ? { extensionId: extension.id, extensionName: extension.name, editor }
    : null;
}

/** Every editor whose selector matches the file, in install order. */
export function editorsForFile(list: ExtensionListLike | null, path: string): ResolvedEditor[] {
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

export function parseDefaults(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** The editor stored for one file in a `band-tab-state:<worktree>` value. */
export function parseFileChoice(raw: string | null | undefined, path: string): string | undefined {
  try {
    const value = (JSON.parse(raw ?? "{}") as Record<string, { editor?: unknown }> | null)?.[path]
      ?.editor;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The tab-state value with one file's editor set, or cleared with `null`. Other fields stay. */
export function withFileChoice(
  raw: string | null | undefined,
  path: string,
  ref: string | null,
): string {
  let states: Record<string, Record<string, unknown>> = {};
  try {
    const parsed = JSON.parse(raw ?? "{}");
    if (parsed && typeof parsed === "object") states = parsed;
  } catch {
    states = {};
  }
  const entry = { ...(states[path] ?? {}) };
  if (ref === null) delete entry.editor;
  else entry.editor = ref;
  states[path] = entry;
  return JSON.stringify(states);
}

/** The extension editor for a file, or null for the built-in viewer. */
export function resolveEditor(
  list: ExtensionListLike | null,
  path: string,
  choice: string | undefined,
  defaults: Record<string, string>,
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

/**
 * The page the WebView loads. The hub accepts a device token as `?token=` (a link login that
 * sets the `band_token` cookie), the only way to authenticate a WebView's first request and
 * every request the page makes after it.
 */
export function embedUrl(
  hubUrl: string,
  token: string,
  worktreeId: string,
  path: string,
  ref: string,
): string {
  const query = new URLSearchParams({ worktreeId, path, editor: ref, token });
  return `${hubUrl.replace(/\/+$/, "")}/embed/editor?${query.toString()}`;
}
