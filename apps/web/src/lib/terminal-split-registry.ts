import type { DockviewApi } from "dockview";

/**
 * Registry + persistence helpers for **nested terminal panes** — the tmux-style
 * split-within-a-terminal-tab feature (issue #643 follow-up).
 *
 * A `term` leaf in the main center dockview
 * (`WorkspaceCenterDockview.tsx`) is no longer a single terminal: it hosts a
 * NESTED, headerless-per-pane `DockviewReact` (`TerminalSplitLeaf`) whose panels
 * are individual terminals (each its own bare-UUID id + PTY). This module is the
 * small amount of shared, module-level state that the nested dockview and the
 * OUTER dockview need to agree on:
 *
 *   1. **Ownership** (`terminalLeafOwner`) — which OUTER leaf owns each pane
 *      terminalId. The outer reconcile / status-event handlers key terminals by
 *      panel id, so without this they'd treat every pane terminalId as a
 *      top-level terminal and spawn a stray sibling tab per pane (regressing to
 *      the pre-#643 behaviour this replaces). The primary pane's terminalId ===
 *      the outer leaf id, and it owns itself.
 *
 *   2. **Focus routing** (`registerTerminalSplitDockview` /
 *      `findFocusedTerminalSplitDockview`) — so the OUTER keydown handler can
 *      DEFER ⌘D / ⌘⇧D / ⌘[ / ⌘] to a terminal leaf's nested dockview when focus
 *      is inside it. Kept separate from `registerInnerDockview` in
 *      `dockview-edge-groups.ts` (which drives the ⌘B/⌥⌘B/⌘J edge toggles) so the
 *      split semantics don't tangle with the edge-toggle semantics.
 *
 *   3. **Nested layout persistence** — the split geometry per leaf, in
 *      localStorage (`band:term-split:<workspaceId>:<leafId>`). This is
 *      deliberately client-only: the server-side `terminalLayout` router was
 *      retired in #643 and must not be reintroduced.
 *
 * Everything here is a per-module-instance singleton (not per React tree),
 * mirroring the registries in `dockview-edge-groups.ts` — one entry per mounted
 * nested dockview.
 */

// ---------------------------------------------------------------------------
// Pane ownership: terminalId → owning outer leaf id
// ---------------------------------------------------------------------------

const terminalLeafOwner = new Map<string, string>();

/** Record that `terminalId` is a pane of the outer leaf `leafId`. Called by
 *  `TerminalSplitLeaf` for every pane (including the primary, where
 *  `terminalId === leafId`) — crucially BEFORE the `terminal.create` mutation
 *  for a split, so the `terminal-created` echo doesn't spawn a stray outer
 *  tab. */
export function registerPaneOwner(terminalId: string, leafId: string): void {
  terminalLeafOwner.set(terminalId, leafId);
}

/** Forget a single pane's ownership (on pane close / kill). */
export function unregisterPaneOwner(terminalId: string): void {
  terminalLeafOwner.delete(terminalId);
}

/** Forget every pane owned by `leafId` (when the whole outer leaf closes). */
export function clearLeafOwners(leafId: string): void {
  for (const [terminalId, owner] of terminalLeafOwner) {
    if (owner === leafId) terminalLeafOwner.delete(terminalId);
  }
}

/** The outer leaf id that owns `terminalId`, or `undefined` if it isn't a
 *  known pane (e.g. a CLI-created terminal that should seed its own tab). */
export function ownerOfTerminal(terminalId: string): string | undefined {
  return terminalLeafOwner.get(terminalId);
}

/** True when `terminalId` is a pane of some open terminal leaf — used by the
 *  outer reconcile / `terminal-created` handler to avoid adding a pane as a
 *  top-level tab. */
export function isOwnedPane(terminalId: string): boolean {
  return terminalLeafOwner.has(terminalId);
}

/** Every terminalId currently owned by `leafId`. The outer `doCloseLeaf` uses
 *  this to kill ALL of a leaf's panes' PTYs when the whole terminal tab is
 *  closed — not just the (possibly already-dead) primary. */
export function terminalsOwnedByLeaf(leafId: string): string[] {
  const ids: string[] = [];
  for (const [terminalId, owner] of terminalLeafOwner) {
    if (owner === leafId) ids.push(terminalId);
  }
  return ids;
}

/** True when `leafId` owns at least one of the given live terminalIds — the
 *  ownership-based survival test the outer reconcile uses to decide whether a
 *  term leaf should be pruned. A leaf survives as long as ANY of its panes'
 *  terminals is still alive on the server, regardless of which pane is the
 *  outer panel's id. */
export function leafOwnsAnyLive(leafId: string, liveTerminalIds: Set<string>): boolean {
  for (const tid of liveTerminalIds) {
    if (terminalLeafOwner.get(tid) === leafId) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Focus routing + status-event routing: leafId → nested DockviewApi
// ---------------------------------------------------------------------------

interface SplitRegistration {
  containerEl: HTMLElement;
  api: DockviewApi;
  leafId: string;
}

// Keyed by leafId so a re-`onReady` for the same leaf replaces cleanly.
const splitRegistrations = new Map<string, SplitRegistration>();

/**
 * Register a terminal leaf's nested dockview (its container element + api).
 * Returns a disposer to unregister on unmount. Idempotent: the disposer only
 * removes the entry if it's still the one this call installed (guards against a
 * later re-register for the same leafId).
 */
export function registerTerminalSplitDockview(
  containerEl: HTMLElement,
  api: DockviewApi,
  leafId: string,
): () => void {
  const registration: SplitRegistration = { containerEl, api, leafId };
  splitRegistrations.set(leafId, registration);
  return () => {
    if (splitRegistrations.get(leafId) === registration) splitRegistrations.delete(leafId);
  };
}

/**
 * The nested dockview whose container currently holds `document.activeElement`,
 * or `null` when focus isn't inside any terminal leaf. The OUTER keydown handler
 * calls this to decide whether to defer split / cycle / close to the nested
 * handler.
 */
export function findFocusedTerminalSplitDockview(): DockviewApi | null {
  const active = document.activeElement;
  if (!active) return null;
  for (const reg of splitRegistrations.values()) {
    if (reg.containerEl.contains(active)) return reg.api;
  }
  return null;
}

/** The nested dockview api for a given outer leaf, if mounted — used to route a
 *  server-side `terminal-killed` for a non-primary pane to the owning leaf. */
export function terminalSplitApiForLeaf(leafId: string): DockviewApi | undefined {
  return splitRegistrations.get(leafId)?.api;
}

// ---------------------------------------------------------------------------
// Nested layout persistence (client-only localStorage)
// ---------------------------------------------------------------------------

const NESTED_LAYOUT_PREFIX = "band:term-split:";

function nestedLayoutKey(workspaceId: string, leafId: string): string {
  return `${NESTED_LAYOUT_PREFIX}${workspaceId}:${leafId}`;
}

/** Read a saved nested split layout, or `null` if absent/unparseable. */
export function readNestedLayout(workspaceId: string, leafId: string): unknown | null {
  try {
    const raw = localStorage.getItem(nestedLayoutKey(workspaceId, leafId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Persist a nested split layout (a dockview `toJSON()` blob). */
export function writeNestedLayout(workspaceId: string, leafId: string, layout: unknown): void {
  try {
    localStorage.setItem(nestedLayoutKey(workspaceId, leafId), JSON.stringify(layout));
  } catch {}
}

/** Delete a leaf's saved nested layout (on outer leaf close). */
export function deleteNestedLayout(workspaceId: string, leafId: string): void {
  try {
    localStorage.removeItem(nestedLayoutKey(workspaceId, leafId));
  } catch {}
}

/**
 * Pre-seed `terminalLeafOwner` from all persisted nested layouts for a
 * workspace, BEFORE the outer dockview reconciles. Each blob's `panels` keys are
 * the pane terminalIds; the leafId is in the storage key. Without this, the
 * outer reconcile (which runs as soon as the layout restores, before the
 * `TerminalSplitLeaf`s mount and register ownership) would see a pane terminalId
 * in `terminal.list`, find no owner, and add it as a top-level tab.
 *
 * Returns the number of pane→leaf mappings seeded (for logging/tests).
 */
export function seedOwnersFromStorage(workspaceId: string): number {
  const prefix = `${NESTED_LAYOUT_PREFIX}${workspaceId}:`;
  let seeded = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const leafId = key.slice(prefix.length);
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      let blob: unknown;
      try {
        blob = JSON.parse(raw);
      } catch {
        continue;
      }
      const panels =
        blob && typeof blob === "object" ? (blob as Record<string, unknown>).panels : undefined;
      if (panels && typeof panels === "object") {
        for (const terminalId of Object.keys(panels as Record<string, unknown>)) {
          terminalLeafOwner.set(terminalId, leafId);
          seeded++;
        }
      }
    }
  } catch {}
  return seeded;
}
