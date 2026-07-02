/**
 * Tracks the last-focused panel per type (chat, terminal, browser) for each
 * workspace.
 *
 * Powers the "Add to Chat" / "Add to Terminal" selection-tooltip actions: they
 * ask this service which chat/terminal the user last had focused in a workspace
 * and route the pasted reference into exactly that panel, rather than
 * broadcasting to every open pane.
 *
 * Persisted in the generic `panel_states` table (one row per workspace under
 * `panelType: "panel_focus"`, keyed by a deterministic id) so the recorded
 * focus survives a page reload / server restart. The in-memory map is the hot
 * path; the DB is the write-through backing store — mirroring the lazy-hydrate
 * + write-through pattern used by `ChatService`.
 */

import { createLogger } from "@band-app/logger";
import {
  deletePanelState,
  insertPanelState,
  listPanelStatesForWorkspace,
  updatePanelState,
} from "../infra/db/queries/panel-states";

const log = createLogger("panel-focus-service");

/** `panel_states.panelType` value used for the per-workspace focus row. */
const PANEL_FOCUS_TYPE = "panel_focus";

/** Panel kinds whose focus we track. */
export type FocusPanelType = "chat" | "terminal" | "browser";

/**
 * The last-focused panel id per type for a single workspace. A missing key
 * means "nothing focused yet" (fresh workspace, or the panel was never opened).
 */
export interface WorkspaceFocus {
  chat?: string;
  terminal?: string;
  browser?: string;
}

/** Deterministic `panel_states.id` for a workspace's focus row. */
function focusRowId(workspaceId: string): string {
  return `${PANEL_FOCUS_TYPE}:${workspaceId}`;
}

export class PanelFocusService {
  /** workspaceId → last-focused panel ids. */
  private readonly focus = new Map<string, WorkspaceFocus>();

  /**
   * Workspaces whose focus row has been loaded from the DB into `focus`.
   * Separate from the map's own key presence because a workspace can have a
   * loaded-but-empty record (row absent) — we still don't want to re-hit the
   * DB on every read.
   */
  private readonly hydrated = new Set<string>();

  /** Workspaces that already have a `panel_states` row (drives insert vs update). */
  private readonly persisted = new Set<string>();

  /**
   * Load a workspace's focus row from the DB on first access. Cheap and
   * idempotent — subsequent calls short-circuit on the `hydrated` set.
   */
  private ensureHydrated(workspaceId: string): void {
    if (this.hydrated.has(workspaceId)) return;
    this.hydrated.add(workspaceId);

    const rows = listPanelStatesForWorkspace(workspaceId, PANEL_FOCUS_TYPE);
    const row = rows[0];
    if (!row) return;

    this.persisted.add(workspaceId);
    try {
      const parsed = JSON.parse(row.state) as WorkspaceFocus;
      this.focus.set(workspaceId, {
        chat: parsed.chat,
        terminal: parsed.terminal,
        browser: parsed.browser,
      });
    } catch (err) {
      log.warn({ workspaceId, err }, "failed to parse persisted panel focus; ignoring");
    }
  }

  /** Get the last-focused panel ids for a workspace. */
  get(workspaceId: string): WorkspaceFocus {
    this.ensureHydrated(workspaceId);
    return { ...(this.focus.get(workspaceId) ?? {}) };
  }

  /**
   * Record that `panelId` is the last-focused panel of `panelType` in
   * `workspaceId`. Write-through: updates the in-memory map and upserts the
   * backing `panel_states` row.
   */
  set(workspaceId: string, panelType: FocusPanelType, panelId: string): void {
    this.ensureHydrated(workspaceId);

    const current = this.focus.get(workspaceId) ?? {};
    if (current[panelType] === panelId) return; // no-op — nothing changed

    const next: WorkspaceFocus = { ...current, [panelType]: panelId };
    this.focus.set(workspaceId, next);

    const now = Date.now();
    const state = JSON.stringify(next);
    if (this.persisted.has(workspaceId)) {
      updatePanelState(focusRowId(workspaceId), { state, updatedAt: now });
    } else {
      insertPanelState({
        id: focusRowId(workspaceId),
        workspaceId,
        panelType: PANEL_FOCUS_TYPE,
        state,
        createdAt: now,
        updatedAt: now,
      });
      this.persisted.add(workspaceId);
    }
  }

  /**
   * Drop all focus tracking for a workspace. Called from the workspace delete
   * path so the row doesn't outlive the workspace.
   */
  remove(workspaceId: string): void {
    this.focus.delete(workspaceId);
    this.hydrated.delete(workspaceId);
    this.persisted.delete(workspaceId);
    // Delete unconditionally: even a fresh boot that never read this workspace
    // (so `persisted` is empty) may still have a row on disk. `deletePanelState`
    // is a no-op when the id is absent.
    deletePanelState(focusRowId(workspaceId));
  }
}

/**
 * Shared singleton consumed by the API tier (`panelFocus` router) and the
 * workspace delete path. Holds in-memory state, so callers MUST go through
 * this instance rather than constructing their own.
 */
export const panelFocusService = new PanelFocusService();
