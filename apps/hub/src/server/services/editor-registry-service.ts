import { randomUUID } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { clientActivityService } from "./client-activity-service";
import { emit } from "./watcher-service";

const log = createLogger("editor-registry");

/** How long an editor call may wait for the tab's answer. */
const CALL_TIMEOUT_MS = 60_000;
/** How long `band_editor_open` waits for a window to open the tab and the editor to be ready. */
const OPEN_TIMEOUT_MS = 30_000;
const MAX_TABS_PER_CLIENT = 64;
const DEFAULT_SELECTION_TTL_MS = 30 * 60_000;

/** How long a selection stays after it was made. Read on every check so a test can shorten it. */
function selectionTtlMs(): number {
  const raw = Number(process.env.BAND_EDITOR_SELECTION_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SELECTION_TTL_MS;
}

export const NO_WINDOW_MESSAGE = "No Band window is open. Ask the person to open Band.";

export interface Selection {
  address: string;
  kind: string;
  label: string;
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface EditorTab {
  clientId: string;
  worktreeId: string;
  file: string;
  extensionId: string;
  editorId: string;
  dirty: boolean;
}

export interface SelectionState {
  file: string;
  extensionId: string;
  editorId: string;
  selection: Selection;
  updatedAt: number;
}

interface StoredSelection extends SelectionState {
  clientId: string;
}

interface PendingCall {
  clientId: string;
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OpenWaiter {
  worktreeId: string;
  file: string;
  extensionId: string;
  editorId: string | undefined;
  resolve: (tab: EditorTab) => void;
}

/** A refusal with a message an agent can act on. */
export class EditorCallError extends Error {}

const tabKey = (t: { clientId: string; worktreeId: string; file: string; extensionId: string }) =>
  `${t.clientId}\u0000${t.worktreeId}\u0000${t.file}\u0000${t.extensionId}`;

/**
 * The editor tabs the connected windows have open, the latest selection per worktree, and the
 * calls an agent makes into a tab. A window names itself with the client id it already reports
 * activity under; a window that stops reporting drops its tabs (`ClientActivityService`, 3
 * minutes), but not its selection. Nothing is persisted: a hub restart forgets the tabs until
 * the windows register again.
 */
export class EditorRegistryService {
  private readonly tabs = new Map<string, EditorTab>();
  private readonly selections = new Map<string, StoredSelection>();
  private readonly calls = new Map<string, PendingCall>();
  private readonly waiters = new Set<OpenWaiter>();

  register(tab: EditorTab): void {
    this.liveTabs();
    const key = tabKey(tab);
    if (!this.tabs.has(key)) {
      const own = [...this.tabs.values()].filter((t) => t.clientId === tab.clientId);
      if (own.length >= MAX_TABS_PER_CLIENT) {
        const oldest = own[0];
        if (oldest) this.drop(oldest);
      }
    }
    this.tabs.set(key, tab);
    for (const waiter of [...this.waiters]) {
      if (
        waiter.worktreeId === tab.worktreeId &&
        waiter.file === tab.file &&
        waiter.extensionId === tab.extensionId &&
        (waiter.editorId === undefined || waiter.editorId === tab.editorId)
      ) {
        this.waiters.delete(waiter);
        waiter.resolve(tab);
      }
    }
  }

  /**
   * Forgets a tab. With `reason: "closed"` (the person closed the tab) the worktree's selection
   * goes too when it came from that file and extension. Without a reason the selection stays,
   * because an unmount also happens on a worktree switch, a reload or the phone leaving its
   * editor screen.
   */
  unregister(
    tab: Pick<EditorTab, "clientId" | "worktreeId" | "file" | "extensionId">,
    reason?: "closed",
  ): void {
    const existing = this.tabs.get(tabKey(tab));
    if (existing) this.drop(existing);
    if (reason !== "closed") return;
    const stored = this.selections.get(tab.worktreeId);
    if (stored && stored.file === tab.file && stored.extensionId === tab.extensionId) {
      this.selections.delete(tab.worktreeId);
      emit({ kind: "editor-selection-changed", worktreeId: tab.worktreeId });
    }
  }

  private drop(tab: EditorTab): void {
    // The selection outlives the tab: the phone closes its editor screen to open the chat.
    this.tabs.delete(tabKey(tab));
  }

  /** Tabs of windows that are still reporting. Tabs of expired windows are forgotten here. */
  private liveTabs(): EditorTab[] {
    const out: EditorTab[] = [];
    for (const tab of [...this.tabs.values()]) {
      if (clientActivityService.isLive(tab.clientId)) out.push(tab);
      else this.drop(tab);
    }
    return out;
  }

  /** The editor tabs open in a worktree, most recently focused window first. */
  list(worktreeId: string): EditorTab[] {
    const order = clientActivityService.clientsByFocus();
    return this.liveTabs()
      .filter((t) => t.worktreeId === worktreeId)
      .sort((a, b) => order.indexOf(a.clientId) - order.indexOf(b.clientId));
  }

  setSelection(
    tab: Pick<EditorTab, "clientId" | "worktreeId" | "file" | "extensionId" | "editorId">,
    selection: Selection | null,
  ): void {
    if (!this.tabs.has(tabKey(tab))) {
      // A selection can arrive before the tab registered; it counts as the tab being there.
      this.register({ ...tab, dirty: false });
    }
    const current = this.selections.get(tab.worktreeId);
    if (selection === null) {
      if (current && current.clientId === tab.clientId && current.file === tab.file) {
        this.selections.delete(tab.worktreeId);
        emit({ kind: "editor-selection-changed", worktreeId: tab.worktreeId });
      }
      return;
    }
    this.selections.set(tab.worktreeId, {
      clientId: tab.clientId,
      file: tab.file,
      extensionId: tab.extensionId,
      editorId: tab.editorId,
      selection,
      updatedAt: Date.now(),
    });
    emit({ kind: "editor-selection-changed", worktreeId: tab.worktreeId });
  }

  /**
   * The latest selection in a worktree, or null when none. It stays after its tab closes or its
   * window stops reporting, until a new selection replaces it, the editor sends `null`, or
   * `BAND_EDITOR_SELECTION_TTL_MS` (30 minutes) passes.
   */
  selection(worktreeId: string): SelectionState | null {
    const stored = this.selections.get(worktreeId);
    if (!stored) return null;
    if (Date.now() - stored.updatedAt > selectionTtlMs()) {
      this.selections.delete(worktreeId);
      emit({ kind: "editor-selection-changed", worktreeId });
      return null;
    }
    const { clientId: _clientId, ...state } = stored;
    return state;
  }

  /** The window's answer to an `editor-call`. Only the window the call went to may answer. */
  result(clientId: string, callId: string, message: Record<string, unknown>): boolean {
    const call = this.calls.get(callId);
    if (!call || call.clientId !== clientId) return false;
    clearTimeout(call.timer);
    this.calls.delete(callId);
    call.resolve(message);
    return true;
  }

  /**
   * Sends one MCP JSON-RPC request into the tab for `(worktree, file, extension)` in the window
   * that most recently had focus, and resolves with the editor's answer.
   */
  call(input: {
    worktreeId: string;
    file: string;
    extensionId: string;
    editorId?: string;
    message: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const tab = this.list(input.worktreeId).find(
      (t) =>
        t.file === input.file &&
        t.extensionId === input.extensionId &&
        (input.editorId === undefined || t.editorId === input.editorId),
    );
    if (!tab) {
      return Promise.reject(
        new EditorCallError(
          `${input.file} is not open in ${input.extensionId}. Call band_editor_open first.`,
        ),
      );
    }
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(callId);
        reject(
          new EditorCallError(
            `The editor window ${tab.clientId.slice(0, 8)} did not answer in time`,
          ),
        );
      }, CALL_TIMEOUT_MS);
      timer.unref();
      this.calls.set(callId, { clientId: tab.clientId, resolve, reject, timer });
      emit({
        kind: "editor-call",
        worktreeId: tab.worktreeId,
        clientId: tab.clientId,
        editorRequest: {
          callId,
          file: tab.file,
          extensionId: tab.extensionId,
          editorId: tab.editorId,
          message: input.message,
        },
      });
    });
  }

  /**
   * Makes sure the file is open in the editor: reuses an open tab, else asks the window that most
   * recently had focus (of any worktree) to open it and waits until the editor is ready.
   */
  async open(input: {
    worktreeId: string;
    file: string;
    extensionId: string;
    editorId: string;
  }): Promise<EditorTab> {
    const existing = this.list(input.worktreeId).find(
      (t) =>
        t.file === input.file &&
        t.extensionId === input.extensionId &&
        t.editorId === input.editorId,
    );
    if (existing) return existing;
    const target = clientActivityService.clientsByFocus()[0];
    if (target === undefined) throw new EditorCallError(NO_WINDOW_MESSAGE);
    return new Promise<EditorTab>((resolve, reject) => {
      const waiter: OpenWaiter = {
        worktreeId: input.worktreeId,
        file: input.file,
        extensionId: input.extensionId,
        editorId: input.editorId,
        resolve: (tab) => {
          clearTimeout(timer);
          resolve(tab);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new EditorCallError(
            `The window did not open ${input.file} in ${input.extensionId}/${input.editorId} in time`,
          ),
        );
      }, OPEN_TIMEOUT_MS);
      timer.unref();
      this.waiters.add(waiter);
      emit({
        kind: "editor-open",
        worktreeId: input.worktreeId,
        clientId: target,
        editorRequest: {
          callId: randomUUID(),
          file: input.file,
          extensionId: input.extensionId,
          editorId: input.editorId,
        },
      });
      log.debug({ target, file: input.file }, "asked a window to open an editor tab");
    });
  }

  /** Forget everything (tests). */
  reset(): void {
    for (const call of this.calls.values()) clearTimeout(call.timer);
    this.calls.clear();
    this.waiters.clear();
    this.tabs.clear();
    this.selections.clear();
  }
}

export const editorRegistryService = new EditorRegistryService();
