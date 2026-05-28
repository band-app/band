/**
 * Typed persistence layer for chat panes.
 *
 * Wraps the generic `panel-states` infra primitive with the chat-specific
 * JSON shape so the service tier can hand the queries a fully-typed
 * `ChatRow` instead of stringly-typed JSON blobs. Lives in Infra (not
 * Services) because the JSON↔row mapping is part of how the DB column
 * is interpreted — knowledge that's exactly one step removed from the
 * SQL itself.
 *
 * Created in issue #316 (Phase 5 of the 3-tier refactor) by lifting the
 * persistence half of `lib/chat-manager.ts` out of the manager and into
 * this class. The in-memory cache + business rules (`validateLabels`,
 * `getOrCreateDefaultChat`, lifecycle events) stay in the service tier
 * (`server/services/chat-service.ts`).
 */

import { createLogger } from "@band-app/logger";
import {
  deletePanelState,
  deletePanelStatesForWorkspace,
  insertPanelState,
  listPanelStates,
  resetPanelStatesToIdle,
  updatePanelState,
} from "./panel-states";

const log = createLogger("chat-queries");

/** `panel_states.panelType` value used for chat rows. */
export const CHAT_PANEL_TYPE = "chat";

/**
 * Chat status as persisted in the `state` JSON blob's `status` field.
 *
 * Mirrors the runtime status the chat-service hands the dashboard. Stored
 * on disk so a server restart can deterministically reset every chat to
 * `"idle"` (see `resetAllToIdle`).
 */
export type ChatStatus = "running" | "idle" | "stopped" | "error";

/**
 * Domain-typed view of a chat row. The on-disk JSON blob and the labels
 * column are pre-decoded by `findAll`; callers get a flat record they can
 * hand the service's in-memory `Map<string, ChatSession>` without any
 * further parsing.
 */
export interface ChatRow {
  id: string;
  workspaceId: string;
  name: string;
  agent: string;
  model: string | undefined;
  mode: string | undefined;
  activeSessionId: string | undefined;
  activeSessionSummary: string | undefined;
  activeSessionLastModified: number | undefined;
  status: ChatStatus;
  labels: Record<string, string>;
}

/**
 * Patch applied by `update` — every field is optional so cosmetic edits
 * (e.g. renaming a chat) don't have to read the row first.
 *
 * `model`/`mode` accept `null` so the service can clear them: the DB column
 * stores `null` for "cleared", `undefined` for "unchanged".
 */
export interface ChatUpdatePatch {
  name?: string;
  agent?: string;
  model?: string | null;
  mode?: string | null;
  activeSessionId?: string | null;
  activeSessionSummary?: string | null;
  activeSessionLastModified?: number | null;
  status?: ChatStatus;
  /**
   * When supplied, replaces the `labels` column. Pass `{}` to clear (the
   * column is stored as SQL `NULL` to keep the on-disk representation
   * compact). Validation lives in the service tier.
   */
  labels?: Record<string, string>;
}

/**
 * Shape of the JSON blob stored in `panel_states.state` for chat rows.
 *
 * Mirrors `ChatRow` minus the `id`/`workspaceId`/`labels` keys (those live
 * on the row itself). Optional fields are nullable on disk so the column
 * stays compact when the chat has never had a session etc.
 */
interface ChatStateBlob {
  name: string;
  agent: string;
  model?: string | null;
  mode?: string | null;
  activeSessionId?: string | null;
  activeSessionSummary?: string | null;
  activeSessionLastModified?: number | null;
  status: ChatStatus;
}

function serializeState(row: {
  name: string;
  agent: string;
  model: string | undefined | null;
  mode: string | undefined | null;
  activeSessionId: string | undefined | null;
  activeSessionSummary: string | undefined | null;
  activeSessionLastModified: number | undefined | null;
  status: ChatStatus;
}): string {
  const blob: ChatStateBlob = {
    name: row.name,
    agent: row.agent,
    model: row.model ?? null,
    mode: row.mode ?? null,
    activeSessionId: row.activeSessionId ?? null,
    activeSessionSummary: row.activeSessionSummary ?? null,
    activeSessionLastModified: row.activeSessionLastModified ?? null,
    status: row.status,
  };
  return JSON.stringify(blob);
}

/**
 * Parse a JSON-encoded labels column into a `Record<string, string>`.
 *
 * Null/empty/malformed input all collapse to `{}` so downstream consumers
 * can treat labels as always-present. Malformed input (bad JSON, wrong
 * top-level type) is warned about so an operator can correlate "where did
 * my labels go?" with the corrupted row; skipped non-string values stay
 * silent because they only happen when a future code change writes the
 * wrong shape — which would already show up as a type error at the call
 * site.
 */
export function parseLabels(
  raw: string | null | undefined,
  chatId?: string,
): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.warn({ chatId, raw }, "labels column had unexpected top-level shape, falling back to {}");
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch (err) {
    log.warn({ chatId, raw, err }, "labels column failed to parse as JSON, falling back to {}");
    return {};
  }
}

/**
 * Serialize labels for DB storage — `null` when empty to keep the on-disk
 * representation compact and to make migrated rows indistinguishable from
 * "no labels".
 *
 * Intentional limitation: `null` on disk represents both "never had labels"
 * (pre-migration row) AND "had labels, now cleared via `chats.update`
 * { labels: {} }". A future query like `WHERE labels IS NOT NULL` would
 * miss the latter category. Both paths converge to `{}` for readers
 * today, which is the only invariant downstream code relies on; the
 * day a use case needs to distinguish them, introduce a sentinel
 * (e.g. `"{}"` for explicitly cleared, `NULL` for never-set) or a
 * separate column rather than re-encoding it onto this one.
 */
export function serializeLabels(labels: Record<string, string>): string | null {
  if (!labels || Object.keys(labels).length === 0) return null;
  return JSON.stringify(labels);
}

/**
 * Persistence operations for the chat half of the `panel_states` table.
 *
 * Stateless — every method reads/writes the DB directly, no in-process
 * cache. The chat service owns the in-memory `Map<chatId, ChatRow>` and
 * decides when to call into here.
 */
export class ChatQueries {
  /** Insert a new chat row. Labels are serialized; `{}` becomes SQL NULL. */
  insert(row: ChatRow & { createdAt: number; updatedAt: number }): void {
    insertPanelState({
      id: row.id,
      workspaceId: row.workspaceId,
      panelType: CHAT_PANEL_TYPE,
      state: serializeState(row),
      labels: serializeLabels(row.labels),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  /**
   * Apply a patch. The patch may touch any subset of fields; the SQL UPDATE
   * always rewrites the full `state` blob (it's a single JSON column, so
   * partial writes would need `json_set` per-field — not worth it for the
   * common case of "update everything that changed").
   *
   * `current` is the in-memory snapshot the service holds — passing it
   * avoids a SELECT round-trip just to merge the patch. Callers must
   * ensure `current` reflects the row they want to update; the service's
   * `chatSessions.get(id)` is the canonical source.
   *
   * Returns the merged shape so the service can update its in-memory copy
   * without re-computing the merge.
   */
  update(id: string, current: ChatRow, patch: ChatUpdatePatch & { updatedAt: number }): ChatRow {
    const merged: ChatRow = {
      ...current,
      name: patch.name ?? current.name,
      agent: patch.agent ?? current.agent,
      model: patch.model === undefined ? current.model : (patch.model ?? undefined),
      mode: patch.mode === undefined ? current.mode : (patch.mode ?? undefined),
      activeSessionId:
        patch.activeSessionId === undefined
          ? current.activeSessionId
          : (patch.activeSessionId ?? undefined),
      activeSessionSummary:
        patch.activeSessionSummary === undefined
          ? current.activeSessionSummary
          : (patch.activeSessionSummary ?? undefined),
      activeSessionLastModified:
        patch.activeSessionLastModified === undefined
          ? current.activeSessionLastModified
          : (patch.activeSessionLastModified ?? undefined),
      status: patch.status ?? current.status,
      labels: patch.labels ?? current.labels,
    };

    const labelsTouched = patch.labels !== undefined;
    updatePanelState(id, {
      state: serializeState(merged),
      updatedAt: patch.updatedAt,
      ...(labelsTouched ? { labels: serializeLabels(merged.labels) } : {}),
    });
    return merged;
  }

  /** Delete a single chat row. */
  remove(id: string): void {
    deletePanelState(id);
  }

  /** Delete every chat row for a workspace. */
  removeAllForWorkspace(workspaceId: string): void {
    deletePanelStatesForWorkspace(workspaceId, CHAT_PANEL_TYPE);
  }

  /**
   * Read every chat row from disk. Each row's JSON `state` is parsed into
   * the typed `ChatRow` shape.
   *
   * Malformed rows are logged and skipped rather than crashing the
   * caller. The service hydrates lazily (`ensureInitialized`) on the
   * first read, so a single corrupted blob would otherwise turn a
   * `chats.list` request into a 500 on every request after a deploy.
   * Skipping the bad row keeps the rest of the workspace's chats
   * usable; operators get the broken `id` in the warning so they can
   * inspect or delete the row manually. Matches `parseLabels`, which
   * already drops invalid labels via the same warn-and-fallback pattern.
   */
  findAll(): ChatRow[] {
    const rows = listPanelStates(CHAT_PANEL_TYPE);
    const out: ChatRow[] = [];
    for (const row of rows) {
      let parsed: ChatStateBlob;
      try {
        parsed = JSON.parse(row.state) as ChatStateBlob;
      } catch (err) {
        log.warn(
          { chatId: row.id, workspaceId: row.workspaceId, err },
          "chat row state failed to parse as JSON, skipping",
        );
        continue;
      }
      out.push({
        id: row.id,
        workspaceId: row.workspaceId,
        name: parsed.name,
        agent: parsed.agent,
        model: parsed.model ?? undefined,
        mode: parsed.mode ?? undefined,
        activeSessionId: parsed.activeSessionId ?? undefined,
        activeSessionSummary: parsed.activeSessionSummary ?? undefined,
        activeSessionLastModified: parsed.activeSessionLastModified ?? undefined,
        status: parsed.status,
        labels: parseLabels(row.labels, row.id),
      });
    }
    return out;
  }

  /**
   * Reset every chat row's persisted `status` to `"idle"` in a single SQL
   * UPDATE. Called once on server boot — see `panel-states.ts` for the
   * `json_set`/`json_extract` rationale and NULL-safety notes.
   */
  resetAllToIdle(updatedAt: number): void {
    resetPanelStatesToIdle(CHAT_PANEL_TYPE, updatedAt);
  }
}
