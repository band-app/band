/**
 * Business logic for chat panes.
 *
 * Services tier — owns the in-memory `Map<chatId, ChatSession>` registry,
 * label validation, layout integration, lifecycle events, and the default-
 * chat resolution rules. Depends on Infra (`ChatQueries`) and on
 * `SettingsService` for agent-definition fallback. Knows nothing about
 * tRPC; the API tier (`server/api/chats/router.ts`) is a thin pass-through.
 *
 * Created in issue #316 (Phase 5 of the 3-tier refactor) by lifting the
 * business half of `lib/chat-manager.ts` + `lib/chat-layout-manager.ts`
 * out of `lib/` and into this class. The intermediate back-compat shim
 * `services/chat-manager.ts` has since been deleted (issue #535
 * cleanup); every former caller now imports `chatService` directly. The
 * `chat-session-summary` helpers (`ensureActiveSessionSummary`,
 * `scheduleActiveSessionRefresh`) were absorbed into this class in the
 * same cleanup pass — see the methods near the bottom of the file.
 */

import { createLogger } from "@band-app/logger";
import { getOrCreateAgent, removeAgent } from "../infra/agents/agent-pool";
import {
  ChatQueries,
  type ChatRow,
  type ChatStatus,
  type ChatUpdatePatch,
} from "../infra/db/queries/chats";
import { DockviewLayoutManager, defaultPanelIdFromLayout } from "./_utils/dockview-layout-manager";
import { settingsService } from "./settings-service";
import { emit } from "./watcher-service";

const log = createLogger("chat-service");

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
 * The hyphen sits at the end of the character class as a literal —
 * Biome's `noUselessEscapeInRegex` rule prohibits writing it as `\-`.
 * Reordering the `_`, `:`, `-` triple would silently turn the class
 * into a range, so keep the hyphen last. */
const LABEL_KEY_REGEX = /^[a-zA-Z0-9_:-]{1,64}$/;

/** Printable-ASCII regex used to validate label values. */
const PRINTABLE_VALUE_REGEX = /^[\x20-\x7E]+$/;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { ChatStatus };

/**
 * Public chat shape — what `chats.list` / `chats.get` hand the dashboard.
 * Identical to `ChatRow` (the Infra shape); aliased here so callers can
 * reach for the domain name (`ChatSession`) rather than the raw infra
 * row type.
 */
export type ChatSession = ChatRow;

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

export interface ActiveSessionUpdate {
  activeSessionId: string | undefined;
  /**
   * Cached display title for `activeSessionId`. Pass `undefined` to clear
   * (e.g. when the user resets to a new session without a summary yet).
   */
  summary?: string;
  lastModified?: number;
}

// ---------------------------------------------------------------------------
// Errors
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
 * Validate a labels record. Returns a fresh, byte-sorted copy on success so
 * call sites can chain `chat.labels = validateLabels(input, ...)`. Throws
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
  // Return a fresh object whose keys are sorted by byte-order (codepoint)
  // comparison. JS preserves insertion order for string keys, so this
  // gives every downstream consumer (JSON.stringify for the DB blob, tRPC
  // serialization for `chats.list`, the CLI table renderer) a stable
  // iteration — without each consumer needing to sort independently.
  // Cost is O(k log k) at write time with k ≤ 20.
  //
  // Byte-order — not `localeCompare` — so the order matches Rust's
  // `String::cmp` used by the CLI's `format_labels_cell`. Under some V8
  // locales `localeCompare` reorders even ASCII `-` / `:` (both permitted
  // by `LABEL_KEY_REGEX`) relative to byte order, which would surface as
  // the CLI table showing the same chat in a different key order than
  // the JSON output.
  const sorted: Record<string, string> = {};
  for (const key of keys.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    sorted[key] = labels[key];
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// ChatService
// ---------------------------------------------------------------------------

/**
 * Lifecycle and orchestration for chat panes.
 *
 * The service owns:
 *   - The in-memory primary index (`chatId → ChatSession`)
 *   - The reverse index (`workspaceId → Set<chatId>`)
 *   - Lazy hydration from `panel_states` on first read
 *   - Layout integration via `DockviewLayoutManager("chat_layout")`
 *   - Emitting `chat-created` / `chat-removed` events on `watcher`
 *
 * Stateful by design — there's exactly one instance (`chatService` below).
 *
 * Object-identity contract: `update*` methods do NOT mutate the prior
 * `ChatSession` in place — they store a fresh merged object in the
 * registry and discard the previous reference. Callers that hold a
 * snapshot from `get`/`list` MUST re-`get` after any mutation to see the
 * new values. (The pre-refactor `lib/chat-manager.ts` mutated in place;
 * every current caller — `task-service`, `chat-events`, the routers,
 * the CLI adapter — already re-reads on each access, so the new
 * contract is a no-op behavioural change for them.)
 */
export class ChatService {
  // Primary index: chatId → ChatSession
  private readonly chatSessions = new Map<string, ChatSession>();
  // Reverse index: workspaceId → Set<chatId>
  private readonly workspaceChats = new Map<string, Set<string>>();

  /**
   * Lazy initialization flag. In dev mode (vite dev) the service may be
   * loaded without an explicit `loadFromDb()` call from start-server.ts.
   * The first public read ensures the DB is hydrated so callers always
   * see persisted chat records.
   */
  private initialized = false;

  constructor(
    private readonly queries: ChatQueries = new ChatQueries(),
    private readonly layoutManager: DockviewLayoutManager = new DockviewLayoutManager(
      "chat_layout",
    ),
  ) {}

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.loadFromDb();
  }

  private addToIndex(session: ChatSession): void {
    this.chatSessions.set(session.id, session);
    let ids = this.workspaceChats.get(session.workspaceId);
    if (!ids) {
      ids = new Set();
      this.workspaceChats.set(session.workspaceId, ids);
    }
    ids.add(session.id);
  }

  private removeFromIndex(chatId: string): void {
    const session = this.chatSessions.get(chatId);
    if (!session) return;
    this.chatSessions.delete(chatId);
    const ids = this.workspaceChats.get(session.workspaceId);
    if (ids) {
      ids.delete(chatId);
      if (ids.size === 0) {
        this.workspaceChats.delete(session.workspaceId);
      }
    }
  }

  private generateChatId(): string {
    return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new chat pane for a workspace.
   * Persists to panel_states and adds to in-memory registry.
   *
   * Intentionally bypasses `ensureInitialized()` — `create` is a pure
   * write-through and the on-boot "all statuses reset to idle" guarantee
   * only matters for callers that read existing rows. Every public read
   * (`get`/`list`/`findByLabels`) lazily initializes, so a write-only
   * sequence (CLI `band chats create` followed straight by `submitTask`)
   * still observes the reset before the first read.
   */
  create(workspaceId: string, options?: CreateChatOptions): ChatSession {
    const defaultAgent = settingsService.getAgentDefinition();
    const now = Date.now();

    const labels = options?.labels
      ? validateLabels(options.labels, {
          rejectReservedPrefix: !options.allowReservedLabels,
        })
      : {};

    const session: ChatSession = {
      id: options?.id ?? this.generateChatId(),
      workspaceId,
      name: options?.name ?? "Chat",
      agent: options?.agent ?? defaultAgent.id,
      model: options?.model,
      mode: options?.mode,
      activeSessionId: undefined,
      activeSessionSummary: undefined,
      activeSessionLastModified: undefined,
      status: "idle",
      labels,
    };

    this.queries.insert({ ...session, createdAt: now, updatedAt: now });

    this.addToIndex(session);

    // Mirror what `terminals.create` and `browsers.create` do: register the
    // new pane in the saved dockview layout so it shows up next time the
    // workspace is opened. Without this, chats created via the CLI (e.g.
    // `band workspaces create --prompt`, `band chats create`, or the lazy
    // `getOrCreateDefaultChat` path) exist as records but are invisible
    // in the dashboard until the user manually opens a tab. `addPanel`
    // is idempotent, so the dashboard's own "+ chat" button — which may
    // also touch the layout client-side — is unaffected.
    this.addToLayout(workspaceId, session.id, { title: session.name });

    // Notify any open dashboard so it can sync its dockview without a
    // page reload. Same pattern as `terminal-created` / `browser-created`.
    emit({ kind: "chat-created", workspaceId, chatId: session.id });

    log.info({ chatId: session.id, workspaceId, agent: session.agent }, "chat pane created");
    return session;
  }

  /** Get a chat session by ID. */
  get(chatId: string): ChatSession | undefined {
    this.ensureInitialized();
    return this.chatSessions.get(chatId);
  }

  /** List all chat sessions for a workspace. */
  list(workspaceId: string): ChatSession[] {
    this.ensureInitialized();
    const ids = this.workspaceChats.get(workspaceId);
    if (!ids) return [];
    const sessions: ChatSession[] = [];
    for (const id of ids) {
      const session = this.chatSessions.get(id);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  /**
   * Update a chat pane's configuration.
   */
  update(chatId: string, updates: UpdateChatOptions): ChatSession | undefined {
    this.ensureInitialized();
    const session = this.chatSessions.get(chatId);
    if (!session) return undefined;

    const incomingLabels = updates.labels;
    let nextLabels: Record<string, string> | undefined;
    if (incomingLabels !== undefined) {
      const rejectReservedPrefix = !updates.allowReservedLabels;
      let next = validateLabels(incomingLabels, { rejectReservedPrefix });
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
      nextLabels = next;
    }

    const patch: ChatUpdatePatch & { updatedAt: number } = {
      updatedAt: Date.now(),
    };
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.agent !== undefined) patch.agent = updates.agent;
    if (updates.model !== undefined) patch.model = updates.model;
    if (updates.mode !== undefined) patch.mode = updates.mode;
    if (nextLabels !== undefined) patch.labels = nextLabels;

    const merged = this.queries.update(chatId, session, patch);
    // Refresh the in-memory copy (preserving object identity is not part
    // of the contract — callers re-read by id).
    this.chatSessions.set(chatId, merged);

    // Log only which fields changed, not their values: users may use labels
    // (256-char printable strings) as ad-hoc context (env=prod, branch=...)
    // that we shouldn't dump into logs. Names/agents/models are also values
    // that don't need to be in info-level logs to be debuggable. The
    // internal-only `allowReservedLabels` escape hatch (set by the cronjob
    // scheduler) is filtered out so it doesn't leak into operator logs as
    // a phantom "field change".
    const updatedFields = Object.keys(updates).filter((k) => k !== "allowReservedLabels");
    log.info({ chatId, updatedFields }, "chat pane updated");
    return merged;
  }

  /**
   * Update a chat pane's status.
   */
  updateStatus(chatId: string, status: ChatStatus): void {
    this.ensureInitialized();
    const session = this.chatSessions.get(chatId);
    if (!session) return;
    const merged = this.queries.update(chatId, session, {
      status,
      updatedAt: Date.now(),
    });
    this.chatSessions.set(chatId, merged);
  }

  /**
   * Update which session the user is currently viewing in this pane.
   * Persisted so refreshing the page restores the same session — and (when
   * provided) the cached title/mtime so first paint avoids a filesystem walk.
   */
  updateActiveSession(chatId: string, update: string | undefined | ActiveSessionUpdate): void {
    this.ensureInitialized();
    const session = this.chatSessions.get(chatId);
    if (!session) return;

    const patch: ChatUpdatePatch & { updatedAt: number } = {
      updatedAt: Date.now(),
    };
    if (typeof update === "string" || update === undefined) {
      patch.activeSessionId = update ?? null;
      // Clear cached summary/lastModified when the session changes without
      // us having pre-resolved metadata. The next chats.get will lazily
      // resolve and persist.
      patch.activeSessionSummary = null;
      patch.activeSessionLastModified = null;
    } else {
      patch.activeSessionId = update.activeSessionId ?? null;
      patch.activeSessionSummary = update.summary ?? null;
      patch.activeSessionLastModified = update.lastModified ?? null;
    }
    const merged = this.queries.update(chatId, session, patch);
    this.chatSessions.set(chatId, merged);
  }

  /**
   * Refresh just the cached summary/lastModified for the chat's active session.
   * Used by the background refresh after `chats.get` to keep the persisted
   * title in sync with the on-disk JSONL when it drifts (e.g. after `/rename`).
   *
   * Returns true if the row was actually updated.
   */
  updateSessionSummary(
    chatId: string,
    sessionId: string,
    summary: string | undefined,
    lastModified: number | undefined,
  ): boolean {
    this.ensureInitialized();
    const session = this.chatSessions.get(chatId);
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
    const merged = this.queries.update(chatId, session, {
      activeSessionSummary: summary ?? null,
      activeSessionLastModified: lastModified ?? null,
      updatedAt: Date.now(),
    });
    this.chatSessions.set(chatId, merged);
    return true;
  }

  /**
   * Remove a chat pane. Kills its agent process, removes from DB,
   * the saved layout, and in-memory maps. Emits a `chat-removed` event
   * so any open dashboard can sync its dockview.
   */
  remove(chatId: string): boolean {
    this.ensureInitialized();
    const session = this.chatSessions.get(chatId);
    if (!session) return false;

    // Kill agent process
    removeAgent(chatId);

    // Remove from DB
    this.queries.remove(chatId);

    // Drop the panel from the saved dockview layout. Mirrors what
    // `terminal.kill` and `browsers.remove` do via their respective
    // `remove*FromLayout` helpers — keeps the layout in sync with
    // the registry so an open dashboard doesn't show a ghost tab.
    this.removeFromLayout(session.workspaceId, chatId);

    // Remove from in-memory maps
    this.removeFromIndex(chatId);

    // Notify any open dashboard. Same pattern as `browser-removed` /
    // `terminal-killed`.
    emit({ kind: "chat-removed", workspaceId: session.workspaceId, chatId });

    log.info({ chatId, workspaceId: session.workspaceId }, "chat pane removed");
    return true;
  }

  /**
   * Remove all chat panes for a workspace.
   * Called when a workspace is deleted.
   *
   * Drops the saved dockview layout in the same call — mirrors `remove()`,
   * which calls `removeFromLayout` so layout cleanup is part of the
   * service-level contract instead of something every caller has to
   * remember to do as a second step. Keeps `ChatService` and
   * `BrowserService` symmetric. `deleteLayout` is a no-op when no layout
   * row exists, so this is safe across workspaces that never opened a chat.
   *
   * `ensureInitialized()` runs first so a workspace deletion that arrives
   * before any public read has hydrated the registry still cleans up the
   * persisted `panel_states` rows — otherwise the `if (ids)` guard would
   * skip the DB delete and leak the rows (and the agents would never be
   * killed).
   */
  removeAllForWorkspace(workspaceId: string): void {
    this.ensureInitialized();

    const ids = this.workspaceChats.get(workspaceId);

    if (ids) {
      // Snapshot the id set before mutating — `removeFromIndex` rewrites
      // `workspaceChats` underneath the iterator. `removeFromIndex`
      // (instead of an inline `chatSessions.delete`) keeps the reverse-
      // index invariant self-enforcing: it empties + deletes the
      // `workspaceChats` set when the last chatId is dropped, so no
      // separate post-loop `workspaceChats.delete(workspaceId)` is
      // needed and a future refactor of the loop can't desync the two
      // indexes.
      for (const chatId of [...ids]) {
        removeAgent(chatId);
        this.removeFromIndex(chatId);
      }

      // Bulk delete chat panel states from DB
      this.queries.removeAllForWorkspace(workspaceId);
    }

    // Always drop the saved layout, even when no in-memory chats exist —
    // a row in `chat_layout` can survive a server restart where the
    // workspace's chats were never hydrated yet.
    this.deleteLayout(workspaceId);

    log.info({ workspaceId }, "all chat panes removed for workspace");
  }

  /**
   * Load all chat panes from the database into the in-memory registry.
   * Called on server startup. Resets all statuses to "idle" since no agent
   * can be running when the server just started.
   */
  loadFromDb(): number {
    this.initialized = true; // mark initialized so ensureInitialized() is a no-op
    const now = Date.now();

    // Single bulk UPDATE: rewrite the `status` field inside every chat row's
    // JSON blob to "idle" in one round-trip (one WAL fsync) instead of N
    // per-row UPDATEs. Skipped for rows already at "idle" so a clean reboot
    // doesn't churn `updated_at` for the whole registry. The in-memory loop
    // below forces `status: "idle"` regardless of what the row says, so this
    // is purely about keeping the persisted state in sync with the runtime.
    this.queries.resetAllToIdle(now);

    const rows = this.queries.findAll();
    for (const row of rows) {
      // Force idle on the in-memory copy: even if the bulk UPDATE skipped
      // this row because it was already "idle" on disk, or — in some odd
      // race — wrote between the UPDATE and the SELECT, we never want to
      // hand the rest of the server a session in a non-idle state on boot.
      const session: ChatSession = { ...row, status: "idle" };
      this.addToIndex(session);
    }

    if (rows.length > 0) {
      log.info({ count: rows.length }, "loaded chat panes from database");
    }
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // Label-based lookup
  // -------------------------------------------------------------------------

  /**
   * Find the first chat in `workspaceId` whose labels match every key/value
   * pair in `match` (AND semantics; extra labels on the chat are ignored).
   * Returns `null` when no chat matches.
   *
   * In-memory filter over `list(workspaceId)` — fast for the workspace
   * sizes we deal with (typically <50 chats) and avoids a per-key SQL query.
   * Used by the cronjob scheduler to claim its own chat via the canonical
   * `band:cronId` label.
   */
  findByLabels(workspaceId: string, match: Record<string, string>): ChatSession | null {
    this.ensureInitialized();
    const keys = Object.keys(match);
    if (keys.length === 0) return null;
    const chats = this.list(workspaceId);
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
  getOrCreateDefault(workspaceId: string): ChatSession {
    const chats = this.list(workspaceId);

    if (chats.length > 0) {
      const layout = this.getLayout(workspaceId);
      const layoutDefault = defaultPanelIdFromLayout(layout);
      if (layoutDefault) {
        const match = chats.find((c) => c.id === layoutDefault);
        if (match) return match;
      }
      return chats[0];
    }

    return this.create(workspaceId, { name: "Chat" });
  }

  // -------------------------------------------------------------------------
  // Layout integration (absorbed from the now-deleted `lib/chat-layout-manager.ts`)
  // -------------------------------------------------------------------------

  /** Get the saved chat layout tree for a workspace, or null when absent. */
  getLayout(workspaceId: string): unknown | null {
    return this.layoutManager.get(workspaceId);
  }

  /** Upsert the saved chat layout tree for a workspace. */
  saveLayout(workspaceId: string, tree: unknown): void {
    this.layoutManager.save(workspaceId, tree);
  }

  /** Delete the saved chat layout for a workspace. */
  deleteLayout(workspaceId: string): void {
    this.layoutManager.delete(workspaceId);
  }

  /** Add a chat panel to the saved dockview layout. */
  addToLayout(workspaceId: string, chatId: string, opts?: { title?: string }): void {
    this.layoutManager.addPanel(workspaceId, {
      id: chatId,
      contentComponent: "chatTab",
      tabComponent: "chatTab",
      title: opts?.title ?? "Chat",
      params: {
        workspaceId,
        chatId,
      },
    });
  }

  /** Remove a chat panel from the saved dockview layout. */
  removeFromLayout(workspaceId: string, chatId: string): void {
    this.layoutManager.removePanel(workspaceId, chatId);
  }

  // -------------------------------------------------------------------------
  // Active-session summary (absorbed from chat-session-summary.ts in #535)
  // -------------------------------------------------------------------------

  /**
   * Resolve and persist the active-session summary when the chat row is
   * missing one. Used by `chats.get` for the migration / fallback case.
   *
   * Returns the updated chat (or the unchanged input if nothing was
   * resolved). Walks through the agent pool because the summary lives on
   * disk in the agent's session JSONL.
   */
  async ensureActiveSessionSummary(
    chatId: string,
    worktreePath: string,
  ): Promise<ChatSession | undefined> {
    const chat = this.get(chatId);
    if (!chat) return undefined;

    // Already cached — nothing to do.
    if (chat.activeSessionId && chat.activeSessionSummary !== undefined) return chat;

    try {
      const agent = await getOrCreateAgent(chatId, worktreePath, chat.agent);

      if (chat.activeSessionId) {
        // Migration / lazy-resolve case: row has activeSessionId but no
        // cached summary. Resolve once and persist.
        if (!agent.getSessionInfo) return chat;
        const info = await agent.getSessionInfo(chat.activeSessionId, worktreePath);
        if (info) {
          this.updateSessionSummary(chatId, chat.activeSessionId, info.summary, info.lastModified);
        }
        // Session file doesn't exist anymore — leave the cached values
        // null. The client will treat this as "no active session" until
        // the next mutation rebuilds the cache.
        return this.get(chatId);
      }

      // No activeSessionId. Leave it null — the legacy
      // `agent.getLatestSession` fallback broke the "New session" flow
      // under the event-log model (handleNewSession clears
      // activeSessionId to null and the subsequent chats.get refetch
      // would re-promote the prior session before the new task starts).
      // See issue #478.
      return chat;
    } catch (err) {
      log.warn({ chatId, err }, "ensureActiveSessionSummary failed");
      return chat;
    }
  }

  /**
   * Fire-and-forget refresh of the cached summary after a `chats.get`
   * returns. Concurrent calls for the same chatId share a single in-flight
   * refresh — a burst of SSE-driven query refetches won't stampede
   * `agent.getSessionInfo`.
   */
  scheduleActiveSessionRefresh(chatId: string, worktreePath: string): void {
    // Cache the map locally so the four accesses below — `has`, `set`,
    // and two in the `.finally` (`get` + `delete`) — share one
    // globalThis lookup instead of hitting the getter four times.
    const refreshes = this.refreshes;
    if (refreshes.has(chatId)) return;

    const promise = this.doRefresh(chatId, worktreePath).finally(() => {
      // Only clear if the entry is still ours — defensive, the Map is
      // keyed per-chatId and the only writer here is this method, but
      // kept for symmetry with the agent-pool dedupe pattern.
      const current = refreshes.get(chatId);
      if (current === promise) refreshes.delete(chatId);
    });
    refreshes.set(chatId, promise);
  }

  /**
   * Per-chatId dedupe map for in-flight refreshes. Stored on a
   * globalThis-keyed singleton (mirroring agent-pool) so multiple bundles
   * of this module — esbuild start-server.mjs + Vite SSR server.js —
   * share one map and don't fork the dedupe set.
   */
  private get refreshes(): Map<string, Promise<void>> {
    const REFRESH_KEY = Symbol.for("band.chat-session-summary.refresh");
    const g = globalThis as unknown as Record<symbol, unknown>;
    if (!g[REFRESH_KEY]) g[REFRESH_KEY] = new Map<string, Promise<void>>();
    return g[REFRESH_KEY] as Map<string, Promise<void>>;
  }

  private async doRefresh(chatId: string, worktreePath: string): Promise<void> {
    try {
      const chat = this.get(chatId);
      if (!chat) return;

      const agent = await getOrCreateAgent(chatId, worktreePath, chat.agent);

      if (chat.activeSessionId) {
        if (!agent.getSessionInfo) return;
        const info = await agent.getSessionInfo(chat.activeSessionId, worktreePath);
        if (!info) {
          // Session file is gone (deleted, moved, etc.). Don't clobber
          // the cached values — they're still useful for the tab title
          // until the user picks a new session.
          return;
        }
        this.updateSessionSummary(chatId, chat.activeSessionId, info.summary, info.lastModified);
        return;
      }

      // No activeSessionId. Leave it null — same rationale as
      // `ensureActiveSessionSummary`. Discovery of prior sessions is now
      // an explicit user action via the history dropdown
      // (`sessions.list`). See issue #478.
    } catch (err) {
      log.warn({ chatId, err }, "active session refresh failed");
    }
  }
}

/**
 * Shared singleton consumed by the API tier (chats router) and the
 * other services that need to look up / mutate chat state
 * (`task-service`, `cronjob-service`, the chat-events / chat-submit
 * handlers under `apps/web/src/api/`). The service holds in-memory
 * state (the chat registry), so callers MUST go through this instance —
 * instantiating a second `ChatService` elsewhere would create a phantom
 * registry that doesn't see the other's writes.
 */
export const chatService = new ChatService();
