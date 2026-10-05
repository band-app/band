/**
 * Tracks the last-focused panel per type (chat, terminal, browser) for each
 * worktree.
 *
 * Powers the "Add to Chat" / "Add to Terminal" selection context menu actions: they
 * ask this service which chat/terminal the user last had focused in a worktree
 * and route the pasted reference into exactly that panel, rather than
 * broadcasting to every open pane.
 *
 * Persisted in the generic `panel_states` table (one row per worktree under
 * `panelType: "panel_focus"`, keyed by a deterministic id) so the recorded
 * focus survives a page reload / server restart. The in-memory map is the hot
 * path; the DB is the write-through backing store — mirroring the lazy-hydrate
 * + write-through pattern used by `ChatService`.
 */

import { createLogger } from "@band-app/logger";
import {
  deletePanelState,
  insertPanelState,
  listPanelStatesForWorktree,
  updatePanelState,
} from "../infra/db/queries/panel-states";

const log = createLogger("panel-focus-service");

/** `panel_states.panelType` value used for the per-worktree focus row. */
const PANEL_FOCUS_TYPE = "panel_focus";

/** Panel kinds whose focus we track. */
export type FocusPanelType = "chat" | "terminal" | "browser";

/**
 * The last-focused panel id per type for a single worktree. A missing key
 * means "nothing focused yet" (fresh worktree, or the panel was never opened).
 */
export interface WorktreeFocus {
  chat?: string;
  terminal?: string;
  browser?: string;
}

/** Deterministic `panel_states.id` for a worktree's focus row. */
function focusRowId(worktreeId: string): string {
  return `${PANEL_FOCUS_TYPE}:${worktreeId}`;
}

export class PanelFocusService {
  /** worktreeId → last-focused panel ids. */
  private readonly focus = new Map<string, WorktreeFocus>();

  /**
   * Worktrees whose focus row has been loaded from the DB into `focus`.
   * Separate from the map's own key presence because a worktree can have a
   * loaded-but-empty record (row absent) — we still don't want to re-hit the
   * DB on every read.
   */
  private readonly hydrated = new Set<string>();

  /** Worktrees that already have a `panel_states` row (drives insert vs update). */
  private readonly persisted = new Set<string>();

  /**
   * Load a worktree's focus row from the DB on first access. Cheap and
   * idempotent — subsequent calls short-circuit on the `hydrated` set.
   */
  private ensureHydrated(worktreeId: string): void {
    if (this.hydrated.has(worktreeId)) return;
    this.hydrated.add(worktreeId);

    const rows = listPanelStatesForWorktree(worktreeId, PANEL_FOCUS_TYPE);
    const row = rows[0];
    if (!row) return;

    this.persisted.add(worktreeId);
    try {
      const parsed = JSON.parse(row.state) as WorktreeFocus;
      this.focus.set(worktreeId, {
        chat: parsed.chat,
        terminal: parsed.terminal,
        browser: parsed.browser,
      });
    } catch (err) {
      log.warn({ worktreeId, err }, "failed to parse persisted panel focus; ignoring");
    }
  }

  /** Get the last-focused panel ids for a worktree. */
  get(worktreeId: string): WorktreeFocus {
    this.ensureHydrated(worktreeId);
    return { ...(this.focus.get(worktreeId) ?? {}) };
  }

  /**
   * Record that `panelId` is the last-focused panel of `panelType` in
   * `worktreeId`. Write-through: updates the in-memory map and upserts the
   * backing `panel_states` row.
   */
  set(worktreeId: string, panelType: FocusPanelType, panelId: string): void {
    this.ensureHydrated(worktreeId);

    const current = this.focus.get(worktreeId) ?? {};
    if (current[panelType] === panelId) return; // no-op — nothing changed

    const next: WorktreeFocus = { ...current, [panelType]: panelId };
    this.focus.set(worktreeId, next);

    const now = Date.now();
    const state = JSON.stringify(next);
    if (this.persisted.has(worktreeId)) {
      updatePanelState(focusRowId(worktreeId), { state, updatedAt: now });
    } else {
      insertPanelState({
        id: focusRowId(worktreeId),
        worktreeId,
        panelType: PANEL_FOCUS_TYPE,
        state,
        createdAt: now,
        updatedAt: now,
      });
      this.persisted.add(worktreeId);
    }
  }

  /**
   * Drop all focus tracking for a worktree. Called from the worktree delete
   * path so the row doesn't outlive the worktree.
   */
  remove(worktreeId: string): void {
    this.focus.delete(worktreeId);
    this.hydrated.delete(worktreeId);
    this.persisted.delete(worktreeId);
    // Delete unconditionally: even a fresh boot that never read this worktree
    // (so `persisted` is empty) may still have a row on disk. `deletePanelState`
    // is a no-op when the id is absent.
    deletePanelState(focusRowId(worktreeId));
  }
}

/**
 * Shared singleton consumed by the API tier (`panelFocus` router) and the
 * worktree delete path. Holds in-memory state, so callers MUST go through
 * this instance rather than constructing their own.
 */
export const panelFocusService = new PanelFocusService();
