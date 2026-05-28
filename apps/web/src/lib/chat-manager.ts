/**
 * Chat pane lifecycle management.
 *
 * Each chat pane maps 1:1 to a running agent process on the server.
 * Modeled on terminal-manager.ts — in-memory registry backed by the
 * generic `panel_states` table for persistence across server restarts.
 */

import { createLogger } from "@band-app/logger";
import { removeAgent } from "./agent-pool";
import { addChatToLayout, getChatLayout, removeChatFromLayout } from "./chat-layout-manager";
import { defaultPanelIdFromLayout } from "./dockview-layout-manager";
import {
  deletePanelState,
  deletePanelStatesForWorkspace,
  insertPanelState,
  listPanelStates,
  resetPanelStatesToIdle,
  updatePanelState,
} from "./panel-state-store";
import { getAgentDefinition, loadSettings } from "./state";
import { emit } from "./watcher";

const log = createLogger("chat-manager");

const PANEL_TYPE = "chat";

// ---------------------------------------------------------------------------
// Label constants (issue #520)
// ---------------------------------------------------------------------------

/**
 * Reserved prefix for Band-internal label keys. Writes to keys with this
 * prefix are rejected from user-facing surfaces (CLI flags, future UI) — only
 * server-side code paths (e.g. the cronjob scheduler) may set them. Kept
 * module-private — external callers should compose with `BAND_CRON_ID_LABEL`
 * (and future siblings) rather than constructing keys from the prefix.
 */
const BAND_LABEL_PREFIX = "band:";

/** Canonical label key used by the cronjob scheduler to claim its own chat. */
export const BAND_CRON_ID_LABEL = "band:cronId";

/** Maximum number of label keys per chat. */
const MAX_LABEL_KEYS = 20;

/** Maximum length of a label value. */
const MAX_LABEL_VALUE_LENGTH = 256;

/** Regex for valid label keys: alphanumerics, `_`, `:`, `-`; 1-64 chars.
 *
 * The hyphen sits at the end of the character class as a literal — moving
 * it between two other characters would silently turn the class into a
 * range. Biome's `noUselessEscapeInRegex` rule prohibits writing it as
 * `\-`, so the literal-at-end form is the only way to keep the intent
 * explicit. Any future edit that shuffles the class order must keep `-`
 * (or `_`) at the end. */
const LABEL_KEY_REGEX = /^[a-zA-Z0-9_:-]{1,64}$/;

/** Printable-ASCII regex used to validate label values. */
const PRINTABLE_VALUE_REGEX = /^[\x20-\x7E]+$/;

export type ChatStatus = "running" | "idle" | "stopped" | "error";

export interface ChatSession {
  id: string;
  workspaceId: string;
  name: string;
  agent: string; // coding agent definition id
  model?: string;
  mode?: string;
  /** The session the user last viewed — restored on page load. */
  activeSessionId?: string;
  /**
   * Cached display title for `activeSessionId` so the chat pane can render
   * its tab title without a filesystem walk on the hot path. Refreshed in
   * the background by `chats.get`.
   */
  activeSessionSummary?: string;
  /**
   * Cached lastModified (ms epoch) for `activeSessionId`. Used by the
   * background refresh to skip the read when the JSONL file hasn't
   * changed since the cached value was written.
   */
  activeSessionLastModified?: number;
  status: ChatStatus;
  /**
   * Free-form labels (issue #520). Empty record when none are set — the
   * `panel_states.labels` column may be NULL for legacy rows but consumers
   * always see `{}` in that case so they don't need to null-check.
   */
  labels: Record<string, string>;
}

/** Shape of the JSON blob stored in `panel_states.state` for chat panels. */
interface ChatPanelState {
  name: string;
  agent: string;
  model?: string | null;
  mode?: string | null;
  /** The session the user last viewed. */
  activeSessionId?: string | null;
  /** Cached display title for activeSessionId. */
  activeSessionSummary?: string | null;
  /** Cached lastModified (ms epoch) for activeSessionId. */
  activeSessionLastModified?: number | null;
  status: ChatStatus;
}

// ---------------------------------------------------------------------------
// In-memory indices
// ---------------------------------------------------------------------------

/** Primary index: chatId -> ChatSession */
const chatSessions = new Map<string, ChatSession>();

/** Reverse index: workspaceId -> Set<chatId> */
const workspaceChats = new Map<string, Set<string>>();

/**
 * Lazy initialization flag.  In dev mode (vite dev) the module may be loaded
 * without an explicit `loadChatsFromDb()` call from start-server.ts.  The
 * first public read ensures the DB is hydrated so callers always see
 * persisted chat records.
 */
let _initialized = false;

function ensureInitialized(): void {
  if (_initialized) return;
  _initialized = true;
  loadChatsFromDb();
}

function addToIndex(session: ChatSession): void {
  chatSessions.set(session.id, session);
  let ids = workspaceChats.get(session.workspaceId);
  if (!ids) {
    ids = new Set();
    workspaceChats.set(session.workspaceId, ids);
  }
  ids.add(session.id);
}

function removeFromIndex(chatId: string): void {
  const session = chatSessions.get(chatId);
  if (!session) return;
  chatSessions.delete(chatId);
  const ids = workspaceChats.get(session.workspaceId);
  if (ids) {
    ids.delete(chatId);
    if (ids.size === 0) {
      workspaceChats.delete(session.workspaceId);
    }
  }
}

function generateChatId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Label validation (issue #520)
// ---------------------------------------------------------------------------

/**
 * Thrown when a labels payload fails validation. Callers (tRPC routes, CLI
 * surface, internal helpers) should let this propagate so the framework
 * maps it to a 400-class response — the helpful message in `.message`
 * already names the specific rule that was violated.
 */
export class InvalidLabelsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLabelsError";
  }
}

interface LabelValidationOptions {
  /**
   * When `true`, writes to keys starting with `band:` are rejected. tRPC
   * routes and other user-facing surfaces pass `true`; the cronjob scheduler
   * (and any other internal caller that legitimately needs to write a
   * reserved key) passes `false`.
   */
  rejectReservedPrefix: boolean;
}

/**
 * Validate a labels record. Returns the input on success so call sites can
 * chain `chat.labels = validateLabels(input, ...)`. Throws
 * `InvalidLabelsError` with a precise message on failure.
 *
 * Rules:
 *  - At most 20 keys.
 *  - Keys match `/^[a-zA-Z0-9_:-]{1,64}$/` (colons allowed for namespacing).
 *  - Values are printable ASCII (0x20–0x7E), 1–256 chars, non-empty.
 *  - When `rejectReservedPrefix: true`, `band:`-prefixed keys are forbidden.
 */
function validateLabels(
  labels: Record<string, string>,
  options: LabelValidationOptions,
): Record<string, string> {
  const keys = Object.keys(labels);
  if (keys.length > MAX_LABEL_KEYS) {
    throw new InvalidLabelsError(
      `labels: too many keys (${keys.length}); max is ${MAX_LABEL_KEYS}`,
    );
  }
  for (const key of keys) {
    // No standalone empty-key guard — `LABEL_KEY_REGEX` already rejects
    // empty strings via the `{1,64}` length quantifier, and the regex
    // message is self-explanatory (`key "" must match /^.../`).
    if (!LABEL_KEY_REGEX.test(key)) {
      throw new InvalidLabelsError(`labels: key "${key}" must match ${LABEL_KEY_REGEX}`);
    }
    if (options.rejectReservedPrefix && key.startsWith(BAND_LABEL_PREFIX)) {
      throw new InvalidLabelsError(
        `labels: key "${key}" uses reserved "${BAND_LABEL_PREFIX}" prefix`,
      );
    }
    const value = labels[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new InvalidLabelsError(`labels: value for "${key}" must be a non-empty string`);
    }
    if (value.length > MAX_LABEL_VALUE_LENGTH) {
      throw new InvalidLabelsError(
        `labels: value for "${key}" exceeds ${MAX_LABEL_VALUE_LENGTH} chars`,
      );
    }
    if (!PRINTABLE_VALUE_REGEX.test(value)) {
      throw new InvalidLabelsError(
        `labels: value for "${key}" must be printable ASCII (0x20-0x7E)`,
      );
    }
  }
  // Return a fresh object whose keys are sorted by byte-order
  // (codepoint) comparison. JS preserves insertion order for string
  // keys, so this gives every downstream consumer (JSON.stringify for
  // the DB blob, tRPC serialization for `chats.list`, the CLI table
  // renderer) a stable iteration — without each consumer needing to
  // sort independently. Cost is O(k log k) at write time with k ≤ 20.
  //
  // Byte-order — not `localeCompare` — so the order matches Rust's
  // `String::cmp` used by the CLI's `format_labels_cell`. Under some
  // V8 locales `localeCompare` reorders even ASCII `-` / `:` (both
  // permitted by `LABEL_KEY_REGEX`) relative to byte order, which
  // would surface as the CLI table showing the same chat in a
  // different key order than the JSON output.
  const sorted: Record<string, string> = {};
  for (const key of keys.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    sorted[key] = labels[key];
  }
  return sorted;
}

/** Serialize labels for DB storage — `null` when empty to keep the on-disk
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
 *
 * Cross-reference: `updateChat` preserves `band:`-prefixed labels across
 * user-facing replacement updates, so a user clearing labels via
 * `chats.update { labels: {} }` does NOT strip the cronjob's
 * `band:cronId` — the disk row will reflect `{"band:cronId": ...}`,
 * not `null`, after a "clear" against a cron-owned chat. */
function serializeLabels(labels: Record<string, string>): string | null {
  if (!labels || Object.keys(labels).length === 0) return null;
  return JSON.stringify(labels);
}

/** Parse the JSON stored in `panel_states.labels`. Null/empty/malformed all
 * collapse to `{}` so downstream consumers can treat labels as always-present.
 * Malformed input (bad JSON, wrong top-level type) is warned about so an
 * operator can correlate "where did my labels go?" with the corrupted row;
 * skipped non-string values stay silent because they only happen when a
 * future code change writes the wrong shape — which would already show up
 * as a type error at the call site. */
function parseLabels(raw: string | null | undefined, chatId?: string): Record<string, string> {
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

function serializeState(session: ChatSession): string {
  const blob: ChatPanelState = {
    name: session.name,
    agent: session.agent,
    model: session.model ?? null,
    mode: session.mode ?? null,
    activeSessionId: session.activeSessionId ?? null,
    activeSessionSummary: session.activeSessionSummary ?? null,
    activeSessionLastModified: session.activeSessionLastModified ?? null,
    status: session.status,
  };
  return JSON.stringify(blob);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateChatOptions {
  /** Explicit ID — use when the client already generated one. */
  id?: string;
  name?: string;
  agent?: string;
  model?: string;
  mode?: string;
  /**
   * Initial label set (issue #520). Validated before persistence — see
   * `validateLabels`. Internal callers that need to write reserved
   * `band:`-prefixed keys must pass `allowReservedLabels: true`.
   */
  labels?: Record<string, string>;
  /**
   * Bypass the `band:` prefix guard for trusted, server-internal callers
   * (e.g. the cronjob scheduler). Defaults to `false` — tRPC routes and the
   * CLI must NOT set this.
   */
  allowReservedLabels?: boolean;
}

/**
 * Create a new chat pane for a workspace.
 * Persists to panel_states table and adds to in-memory registry.
 */
export function createChat(workspaceId: string, options?: CreateChatOptions): ChatSession {
  const settings = loadSettings();
  const defaultAgent = getAgentDefinition(settings);
  const now = Date.now();

  const labels = options?.labels
    ? validateLabels(options.labels, {
        rejectReservedPrefix: !options.allowReservedLabels,
      })
    : {};

  const session: ChatSession = {
    id: options?.id ?? generateChatId(),
    workspaceId,
    name: options?.name ?? "Chat",
    agent: options?.agent ?? defaultAgent.id,
    model: options?.model,
    mode: options?.mode,
    status: "idle",
    labels,
  };

  insertPanelState({
    id: session.id,
    workspaceId: session.workspaceId,
    panelType: PANEL_TYPE,
    state: serializeState(session),
    labels: serializeLabels(session.labels),
    createdAt: now,
    updatedAt: now,
  });

  addToIndex(session);

  // Mirror what `terminals.create` and `browsers.create` do: register the
  // new pane in the saved dockview layout so it shows up next time the
  // workspace is opened. Without this, chats created via the CLI (e.g.
  // `band workspaces create --prompt`, `band chats create`, or the lazy
  // `getOrCreateDefaultChat` path) exist as records but are invisible
  // in the dashboard until the user manually opens a tab. `addPanel`
  // is idempotent, so the dashboard's own "+ chat" button — which may
  // also touch the layout client-side — is unaffected.
  addChatToLayout(workspaceId, session.id, { title: session.name });

  // Notify any open dashboard so it can sync its dockview without a
  // page reload. Same pattern as `terminal-created` / `browser-created`.
  emit({ kind: "chat-created", workspaceId, chatId: session.id });

  log.info({ chatId: session.id, workspaceId, agent: session.agent }, "chat pane created");
  return session;
}

/**
 * Get a chat session by ID.
 */
export function getChat(chatId: string): ChatSession | undefined {
  ensureInitialized();
  return chatSessions.get(chatId);
}

/**
 * List all chat sessions for a workspace.
 */
export function listChats(workspaceId: string): ChatSession[] {
  ensureInitialized();
  const ids = workspaceChats.get(workspaceId);
  if (!ids) return [];
  const sessions: ChatSession[] = [];
  for (const id of ids) {
    const session = chatSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
}

export interface UpdateChatOptions {
  name?: string;
  agent?: string;
  model?: string | null;
  mode?: string | null;
  /**
   * Replace the chat's full label set (issue #520). Pass `{}` to clear.
   * Validated before persistence — see `validateLabels`. Reserved
   * `band:`-prefixed keys are rejected unless `allowReservedLabels: true`.
   */
  labels?: Record<string, string>;
  /** Bypass the `band:` prefix guard for trusted internal callers. */
  allowReservedLabels?: boolean;
}

/**
 * Update a chat pane's configuration.
 */
export function updateChat(chatId: string, updates: UpdateChatOptions): ChatSession | undefined {
  const session = chatSessions.get(chatId);
  if (!session) return undefined;

  if (updates.name !== undefined) session.name = updates.name;
  if (updates.agent !== undefined) session.agent = updates.agent;
  if (updates.model !== undefined) session.model = updates.model ?? undefined;
  if (updates.mode !== undefined) session.mode = updates.mode ?? undefined;
  const labelsTouched = updates.labels !== undefined;
  if (labelsTouched) {
    const rejectReservedPrefix = !updates.allowReservedLabels;
    let next = validateLabels(updates.labels!, { rejectReservedPrefix });
    if (rejectReservedPrefix) {
      // Preserve any pre-existing `band:`-prefixed labels that the
      // caller's full-set replacement would otherwise drop. The reserved
      // prefix is meant to mean "user-facing surfaces can't touch
      // these" — but because `chats.update` semantics are "replace the
      // whole record", a user who calls `band chats unlabel <id>
      // band:cronId` (or just sends a labels payload that omits the
      // reserved keys) would silently strip the server's internal
      // bookkeeping, orphaning the chat from its cronjob and causing
      // the next fire to create a fresh one. Validation can't catch
      // that on its own — the new payload is well-formed. Merging the
      // existing reserved keys back in makes the invariant hold for
      // the lifecycle of those keys, not just for the moment they're
      // first written. Internal callers passing `allowReservedLabels`
      // intentionally skip this preservation step (they may need to
      // explicitly clear a reserved key during teardown).
      const reservedKeys = Object.keys(session.labels).filter((k) =>
        k.startsWith(BAND_LABEL_PREFIX),
      );
      if (reservedKeys.length > 0) {
        const merged: Record<string, string> = { ...next };
        for (const k of reservedKeys) merged[k] = session.labels[k];
        next = validateLabels(merged, { rejectReservedPrefix: false });
      }
    }
    session.labels = next;
  }

  // Only rewrite the labels column when the caller actually touched
  // labels — cosmetic updates (name/model/mode-only) shouldn't churn
  // the column or bump `updated_at` on a field they didn't change.
  // Drizzle's `set` silently skips `undefined` properties, so we
  // conditionally include `labels` rather than passing `undefined`
  // (which would also skip but is less explicit).
  updatePanelState(chatId, {
    state: serializeState(session),
    updatedAt: Date.now(),
    ...(labelsTouched ? { labels: serializeLabels(session.labels) } : {}),
  });

  // Log only which fields changed, not their values: users may use labels
  // (256-char printable strings) as ad-hoc context (env=prod, branch=...)
  // that we shouldn't dump into logs. Names/agents/models are also values
  // that don't need to be in info-level logs to be debuggable.
  log.info({ chatId, updatedFields: Object.keys(updates) }, "chat pane updated");
  return session;
}

/**
 * Update a chat pane's status.
 */
export function updateChatStatus(chatId: string, status: ChatStatus): void {
  const session = chatSessions.get(chatId);
  if (!session) return;
  session.status = status;

  updatePanelState(chatId, {
    state: serializeState(session),
    updatedAt: Date.now(),
  });
}

export interface ActiveSessionUpdate {
  activeSessionId: string | undefined;
  /**
   * Cached display title for `activeSessionId`. Pass `undefined` to clear
   * (e.g. when the user resets to a new session without a summary yet).
   */
  summary?: string;
  lastModified?: number;
}

/**
 * Update which session the user is currently viewing in this pane.
 * Persisted so refreshing the page restores the same session — and (when
 * provided) the cached title/mtime so first paint avoids a filesystem walk.
 */
export function updateChatActiveSession(
  chatId: string,
  update: string | undefined | ActiveSessionUpdate,
): void {
  const session = chatSessions.get(chatId);
  if (!session) return;

  if (typeof update === "string" || update === undefined) {
    session.activeSessionId = update;
    // Clear cached summary/lastModified when the session changes without
    // us having pre-resolved metadata. The next chats.get will lazily
    // resolve and persist.
    session.activeSessionSummary = undefined;
    session.activeSessionLastModified = undefined;
  } else {
    session.activeSessionId = update.activeSessionId;
    session.activeSessionSummary = update.summary;
    session.activeSessionLastModified = update.lastModified;
  }

  updatePanelState(chatId, {
    state: serializeState(session),
    updatedAt: Date.now(),
  });
}

/**
 * Refresh just the cached summary/lastModified for the chat's active session.
 * Used by the background refresh after `chats.get` to keep the persisted
 * title in sync with the on-disk JSONL when it drifts (e.g. after `/rename`).
 *
 * Returns true if the row was actually updated.
 */
export function updateChatSessionSummary(
  chatId: string,
  sessionId: string,
  summary: string | undefined,
  lastModified: number | undefined,
): boolean {
  const session = chatSessions.get(chatId);
  if (!session) return false;
  // Stale write guard: only apply if the cached row still references the
  // same activeSessionId. Otherwise the user moved on between the read
  // and the refresh and we'd clobber the new state with old data.
  if (session.activeSessionId !== sessionId) return false;
  if (
    session.activeSessionSummary === summary &&
    session.activeSessionLastModified === lastModified
  ) {
    return false;
  }
  session.activeSessionSummary = summary;
  session.activeSessionLastModified = lastModified;

  updatePanelState(chatId, {
    state: serializeState(session),
    updatedAt: Date.now(),
  });
  return true;
}

/**
 * Remove a chat pane. Kills its agent process, removes from DB,
 * the saved layout, and in-memory maps. Emits a `chat-removed` event
 * so any open dashboard can sync its dockview.
 */
export function removeChat(chatId: string): boolean {
  const session = chatSessions.get(chatId);
  if (!session) return false;

  // Kill agent process
  removeAgent(chatId);

  // Remove from DB
  deletePanelState(chatId);

  // Drop the panel from the saved dockview layout. Mirrors what
  // `terminal.kill` and `browsers.remove` do via their respective
  // `remove*FromLayout` helpers — keeps the layout in sync with
  // the registry so an open dashboard doesn't show a ghost tab.
  removeChatFromLayout(session.workspaceId, chatId);

  // Remove from in-memory maps
  removeFromIndex(chatId);

  // Notify any open dashboard. Same pattern as `browser-removed` /
  // `terminal-killed`.
  emit({ kind: "chat-removed", workspaceId: session.workspaceId, chatId });

  log.info({ chatId, workspaceId: session.workspaceId }, "chat pane removed");
  return true;
}

/**
 * Remove all chat panes for a workspace.
 * Called when a workspace is deleted.
 */
export function removeWorkspaceChats(workspaceId: string): void {
  const ids = workspaceChats.get(workspaceId);
  if (!ids) return;

  for (const chatId of [...ids]) {
    removeAgent(chatId);
    chatSessions.delete(chatId);
  }

  // Bulk delete chat panel states from DB
  deletePanelStatesForWorkspace(workspaceId, PANEL_TYPE);

  workspaceChats.delete(workspaceId);
  log.info({ workspaceId }, "all chat panes removed for workspace");
}

/**
 * Load all chat panes from the database into the in-memory registry.
 * Called on server startup. Resets all statuses to "idle" since no agent
 * can be running when the server just started.
 */
export function loadChatsFromDb(): number {
  _initialized = true; // Mark as initialized so ensureInitialized() is a no-op
  const now = Date.now();

  // Single bulk UPDATE: rewrite the `status` field inside every chat row's
  // JSON blob to "idle" in one round-trip (one WAL fsync) instead of N
  // per-row UPDATEs. Skipped for rows already at "idle" so a clean reboot
  // doesn't churn `updated_at` for the whole registry. The in-memory loop
  // below forces `status: "idle"` regardless of what the row says, so this
  // is purely about keeping the persisted state in sync with the runtime.
  resetPanelStatesToIdle(PANEL_TYPE, now);

  const rows = listPanelStates(PANEL_TYPE);
  for (const row of rows) {
    const parsed = JSON.parse(row.state) as ChatPanelState;

    const session: ChatSession = {
      id: row.id,
      workspaceId: row.workspaceId,
      name: parsed.name,
      agent: parsed.agent,
      model: parsed.model ?? undefined,
      mode: parsed.mode ?? undefined,
      activeSessionId: parsed.activeSessionId ?? undefined,
      activeSessionSummary: parsed.activeSessionSummary ?? undefined,
      activeSessionLastModified: parsed.activeSessionLastModified ?? undefined,
      // Force idle on the in-memory copy: even if the bulk UPDATE skipped
      // this row because it was already "idle" on disk, or — in some odd
      // race — wrote between the UPDATE and the SELECT, we never want to
      // hand the rest of the server a session in a non-idle state on boot.
      status: "idle",
      labels: parseLabels(row.labels, row.id),
    };
    addToIndex(session);
  }

  if (rows.length > 0) {
    log.info({ count: rows.length }, "loaded chat panes from database");
  }
  return rows.length;
}

/**
 * Find the first chat in `workspaceId` whose labels match every key/value
 * pair in `match` (AND semantics; extra labels on the chat are ignored).
 * Returns `null` when no chat matches.
 *
 * In-memory filter over `listChats(workspaceId)` — fast for the workspace
 * sizes we deal with (typically <50 chats) and avoids a per-key SQL query.
 * Used by the cronjob scheduler to claim its own chat via the canonical
 * `band:cronId` label.
 */
export function findChatByLabels(
  workspaceId: string,
  match: Record<string, string>,
): ChatSession | null {
  ensureInitialized();
  const keys = Object.keys(match);
  if (keys.length === 0) return null;
  const chats = listChats(workspaceId);
  for (const chat of chats) {
    let allMatch = true;
    for (const k of keys) {
      if (chat.labels[k] !== match[k]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return chat;
  }
  return null;
}

/**
 * Get or create a default chat pane for a workspace.
 *
 * Resolution order:
 *   1. The active panel from the saved chat layout (e.g. the tab the user
 *      last focused in the dashboard). This makes CLI commands like
 *      `band chat ...` target the same chat the user is looking at.
 *   2. The first chat panel in the saved layout, even if not active.
 *   3. The first chat in the in-memory registry (insertion order).
 *   4. A freshly-created "Chat" panel if the workspace has none yet.
 *
 * Used by the CLI (`band chat`), cronjobs, and tRPC routes that accept an
 * optional chatId — all of them want a single deterministic answer to
 * "which chat does this workspace mean by default".
 */
export function getOrCreateDefaultChat(workspaceId: string): ChatSession {
  const chats = listChats(workspaceId);

  if (chats.length > 0) {
    const layout = getChatLayout(workspaceId);
    const layoutDefault = defaultPanelIdFromLayout(layout);
    if (layoutDefault) {
      const match = chats.find((c) => c.id === layoutDefault);
      if (match) return match;
    }
    return chats[0];
  }

  return createChat(workspaceId, { name: "Chat" });
}
