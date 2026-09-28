/**
 * Which localStorage keys are kept on the Band server (see
 * `lib/client-state.ts`) and how each maps to a server entry. The server uses
 * the same table to refuse keys that aren't listed and to take a key's
 * workspace from the key itself.
 *
 * A key's scope is `all` (one value shared by every device) or `device` (one
 * value per device type: desktop or mobile). A key can map to several server
 * entries: `band-tab-state:<ws>` shares each file's view mode and language
 * with every device but keeps scroll position per device type.
 *
 * Keys not listed here stay on the device: the agent mode (`band.agent-mode`,
 * per device on purpose, #685), experimental flags, and sessionStorage caches.
 */

export type KeyScope = "all" | "device";

export interface KeyPart {
  scope: KeyScope;
  /** Server value for the local raw value; null deletes the server entry. */
  pick: (raw: string | null) => unknown;
  /** New local raw value after the server value arrives; null removes the key. */
  merge: (raw: string | null, value: unknown) => string | null;
}

export interface KeyRule {
  /** The workspace the key belongs to (null for a global key), or undefined when the key isn't this rule's. */
  match: (key: string) => string | null | undefined;
  parts: KeyPart[];
}

/** The value is a plain string (a width, a branch name, a draft). */
function rawPart(scope: KeyScope): KeyPart {
  return {
    scope,
    pick: (raw) => raw,
    merge: (_raw, value) => (typeof value === "string" ? value : null),
  };
}

/** The value is JSON; the server stores it parsed. */
function jsonPart(scope: KeyScope): KeyPart {
  return {
    scope,
    pick: (raw) => {
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    merge: (_raw, value) => (value == null ? null : JSON.stringify(value)),
  };
}

type PerFile = Record<string, Record<string, unknown>>;

function parsePerFile(raw: string | null): PerFile {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A `Record<filePath, state>` value of which this part owns some fields of
 * every file. Other fields (the other part's, or local-only ones) are left
 * alone on merge.
 */
function perFileFieldsPart(scope: KeyScope, fields: readonly string[]): KeyPart {
  return {
    scope,
    pick: (raw) => {
      const picked: PerFile = {};
      for (const [path, state] of Object.entries(parsePerFile(raw))) {
        if (!state || typeof state !== "object") continue;
        const own: Record<string, unknown> = {};
        for (const f of fields) if (state[f] !== undefined) own[f] = state[f];
        if (Object.keys(own).length > 0) picked[path] = own;
      }
      return Object.keys(picked).length > 0 ? picked : null;
    },
    merge: (raw, value) => {
      const local = parsePerFile(raw);
      for (const state of Object.values(local)) {
        if (state && typeof state === "object") for (const f of fields) delete state[f];
      }
      if (value && typeof value === "object") {
        for (const [path, state] of Object.entries(value as PerFile)) {
          if (!state || typeof state !== "object") continue;
          const next = { ...(local[path] ?? {}) };
          for (const f of fields) if (state[f] !== undefined) next[f] = state[f];
          local[path] = next;
        }
      }
      for (const [path, state] of Object.entries(local)) {
        if (!state || typeof state !== "object" || Object.keys(state).length === 0) {
          delete local[path];
        }
      }
      return Object.keys(local).length > 0 ? JSON.stringify(local) : null;
    },
  };
}

function exact(key: string, parts: KeyPart[]): KeyRule {
  return { match: (k) => (k === key ? null : undefined), parts };
}

/** `<prefix><workspaceId>` */
function perWorkspace(prefix: string, parts: KeyPart[]): KeyRule {
  return {
    match: (k) =>
      k.startsWith(prefix) && k.length > prefix.length ? k.slice(prefix.length) : undefined,
    parts,
  };
}

/** `<prefix><workspaceId>:<leafId>`. Workspace ids never contain a colon. */
function perWorkspaceLeaf(prefix: string, parts: KeyPart[]): KeyRule {
  return {
    match: (k) => {
      if (!k.startsWith(prefix)) return undefined;
      const rest = k.slice(prefix.length);
      const colon = rest.indexOf(":");
      return colon > 0 && colon < rest.length - 1 ? rest.slice(0, colon) : undefined;
    },
    parts,
  };
}

/** The center dockview's tab list, shared by every device. */
export const CENTER_TABS_PREFIX = "band:center-tabs:";

const RULES: KeyRule[] = [
  // Shared across devices.
  exact("band-recent-workspaces", [jsonPart("all")]),
  exact("band.projects-list.collapsed-projects", [jsonPart("all")]),
  exact("band.projects-list.collapsed-labels", [jsonPart("all")]),
  exact("band.projects-list.collapsed-pinned", [jsonPart("all")]),
  exact("band.projects-list.label-filter", [rawPart("all")]),
  exact("band.projects-list.label-last-workspace", [jsonPart("all")]),
  perWorkspace(CENTER_TABS_PREFIX, [jsonPart("all")]),
  perWorkspaceLeaf("band:term-split:", [jsonPart("all")]),
  perWorkspace("band:diff-compare-branch:", [rawPart("all")]),
  perWorkspace("band-draft:", [rawPart("all")]),
  // A file's unsaved text, or an untitled buffer's (`<prefix><ws>:<path>`).
  perWorkspaceLeaf("band-unsaved:", [rawPart("all")]),
  perWorkspace("band-tab-state:", [
    perFileFieldsPart("all", ["viewMode", "language"]),
    perFileFieldsPart("device", ["scrollTop", "selection"]),
  ]),

  // One value per device type.
  exact("band:sidebar-width", [rawPart("device")]),
  exact("band:sidebar-collapsed", [rawPart("device")]),
  exact("band:right-panel-width", [rawPart("device")]),
  exact("band:right-panel-collapsed", [rawPart("device")]),
  exact("band:right-sidepanel-tab", [rawPart("device")]),
  exact("band:commits-panel-collapsed", [rawPart("device")]),
  exact("band:commits-panel-height", [rawPart("device")]),
  exact("band:changes-collapsed-sections", [jsonPart("device")]),
  exact("band:diff-view-mode", [rawPart("device")]),
  exact("band:zoom-level", [rawPart("device")]),
  perWorkspace("band:dockview-layout-v9:", [jsonPart("device")]),
];

export interface MatchedKey {
  workspaceId: string | null;
  parts: KeyPart[];
}

export function matchKey(key: string): MatchedKey | null {
  for (const rule of RULES) {
    const workspaceId = rule.match(key);
    if (workspaceId !== undefined) return { workspaceId, parts: rule.parts };
  }
  return null;
}
