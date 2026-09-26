import { createLogger } from "@band-app/logger";
import { z } from "zod";
import type { WorkspaceTerminalConfig } from "@/dashboard";
import { loadProjectConfig } from "../infra/setup/project-config";
import { TerminalDaemonUnavailableError } from "../infra/terminals/daemon/daemon-backend";
import { InProcessTerminalBackend } from "../infra/terminals/in-process-backend";
import type {
  SpawnOptions,
  TerminalAttachment,
  TerminalBackend,
  TerminalExitEvent,
  TerminalListEntry,
} from "../infra/terminals/terminal-backend";
import { TitlePoller } from "../infra/terminals/title-poller";
import {
  addTerminalToLayout,
  deleteTerminalLayout,
  removeTerminalFromLayout,
} from "./_utils/terminal-layout-manager";
import { emit } from "./watcher-service";
import { workspaceService } from "./workspace-service";

// Re-export the terminal types so the API tier (`terminals/router.ts`,
// `terminals/ws.ts`) can reference them without reaching into infra.
// Routers must not import from infra, so they get these types here.
export type { SpawnOptions, TerminalAttachment, TerminalExitEvent, TerminalListEntry };

/** One step of {@link TerminalService.stream}. */
export type TerminalStreamEvent =
  | { kind: "missing" }
  | { kind: "snapshot"; data: string }
  | { kind: "output"; data: string }
  | { kind: "exit" };

const log = createLogger("terminal-service");

// ---------------------------------------------------------------------------
// Zod schemas for the workspace `.band/config.json` `workspace.terminal` block
//
// The schema and `loadWorkspaceConfig` helper used to live in
// `lib/terminal-config.ts`. They were absorbed into the service tier as part
// of the Phase 7 3-tier refactor (issue #318) — config parsing is a piece of
// terminal business logic that callers (currently the workspace router's
// `getTerminalConfig` query) reach via `terminalService` rather than a
// stand-alone helper.
// ---------------------------------------------------------------------------

const TerminalPaneConfigSchema = z.object({
  name: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  focus: z.boolean().optional(),
});

const PaneNodeSchema = z.object({
  pane: TerminalPaneConfigSchema,
});

type TerminalLayoutNodeInput =
  | { pane: z.infer<typeof TerminalPaneConfigSchema> }
  | {
      direction: "horizontal" | "vertical";
      split?: number;
      children: [TerminalLayoutNodeInput, TerminalLayoutNodeInput];
    };

const TerminalLayoutNodeSchema: z.ZodType<TerminalLayoutNodeInput> = z.lazy(() =>
  z.union([
    PaneNodeSchema,
    z.object({
      direction: z.enum(["horizontal", "vertical"]),
      split: z.number().min(0.1).max(0.9).optional().default(0.5),
      children: z.tuple([TerminalLayoutNodeSchema, TerminalLayoutNodeSchema]),
    }),
  ]),
);

const WorkspaceTerminalConfigSchema = z.object({
  layout: TerminalLayoutNodeSchema,
});

/**
 * Business logic for the terminal domain.
 *
 * Services tier — coordinates the {@link TerminalBackend} (PTY lifecycle,
 * in this process or in the terminal daemon), the dockview layout store (so
 * a freshly spawned terminal survives a reload), and the workspace status
 * event bus. The backend stays oblivious to the workspace registry; the
 * service is the one that resolves a workspaceId to a worktree path and
 * decides which side effects fire on spawn / kill.
 *
 * Callers:
 *   - The tRPC `terminals` router (`server/api/terminals/router.ts`) for
 *     CRUD-shaped procedures.
 *   - The terminal WebSocket handler (`server/api/terminals/ws.ts`) for
 *     spawning + attaching a live PTY.
 *   - The workspace router, for `getTerminalConfig`, and the workspace
 *     deletion cleanup (`killWorkspace` + `deleteLayout`).
 *   - `start-server.ts`, which picks the backend at boot and calls
 *     {@link close} on shutdown.
 */
export class TerminalService {
  private backend!: TerminalBackend;
  private unsubscribeExit: (() => void) | null = null;
  /** terminalId -> exit listeners, so an exit only reaches its own viewers. */
  private readonly exitListeners = new Map<string, Set<(event: TerminalExitEvent) => void>>();
  /** Tab titles for every open terminal, from one shared poll of the current backend. */
  private readonly titles = new TitlePoller(() => this.backend.listAll());

  constructor(backend: TerminalBackend = new InProcessTerminalBackend()) {
    this.setBackend(backend);
  }

  /**
   * Switch where PTYs live. Called once at boot by `start-server.ts`, and
   * again if the daemon backend cannot start and the service falls back to
   * an in-process one. Sessions on the previous backend are not carried over.
   */
  setBackend(backend: TerminalBackend): void {
    this.unsubscribeExit?.();
    // Release the one being replaced (a no-op for the empty boot default; a
    // disconnect for a daemon backend that failed to spawn).
    if (this.backend) {
      void this.backend.close().catch((err) => {
        log.warn("failed to close the replaced terminal backend: %s", err);
      });
    }
    this.backend = backend;
    this.unsubscribeExit = backend.onExit((event) => this.handleExit(event));
  }

  // -------------------------------------------------------------------------
  // PTY lifecycle
  // -------------------------------------------------------------------------

  /**
   * Spawn a new PTY for the given workspace + terminalId.
   *
   * Resolves `workspaceId` to a worktree path before delegating to the
   * backend, and registers the new terminal in the saved dockview layout so
   * it survives a server restart (mirrors `chatService.create` /
   * `browserService.create`). Does NOT emit a `terminal-created` event —
   * the API entry points decide whether to broadcast (the WebSocket handler
   * stays silent; the tRPC `create` mutation emits explicitly).
   */
  async spawn(
    workspaceId: string,
    terminalId: string,
    options?: SpawnOptions,
    // `cleanupOnExit` (issue #581): when set, a *natural* PTY exit (e.g. a
    // self-closing cron pane whose command ended with `exit`) triggers the same
    // teardown as an explicit `kill` — the tab is dropped from the saved layout
    // and a `terminal-killed` event is emitted. Off by default so a user's
    // interactive terminal keeps its "Terminal exited" pane on screen (existing
    // behavior); only opt-in callers get the auto-prune. The backend stores the
    // flag on the session and reports it back on the exit event (see
    // `handleExit`), so it holds even when the shell outlives this server.
    opts?: { cleanupOnExit?: boolean },
  ): Promise<TerminalListEntry> {
    const workspace = workspaceService.resolve(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    const request = {
      workspaceId,
      terminalId,
      workspaceRoot: workspace.worktree.path,
      options,
      cleanupOnExit: opts?.cleanupOnExit,
    };
    const backend = this.backend;
    let entry: TerminalListEntry;
    try {
      entry = await backend.spawn(request);
    } catch (err) {
      if (!(err instanceof TerminalDaemonUnavailableError)) throw err;
      // A terminal that dies with the server beats no terminal. Swap only
      // once: concurrent spawns that failed together must land on the same
      // replacement.
      if (this.backend === backend) {
        log.error(
          { err },
          "terminal daemon unavailable; falling back to in-process terminals, which will not survive a server restart",
        );
        this.setBackend(new InProcessTerminalBackend());
      }
      entry = await this.backend.spawn(request);
    }

    // The workspace can be removed while the spawn is in flight (e.g.
    // `band workspaces create --prompt` spawns fire-and-forget and a quick
    // `workspaces remove` follows). Its `killWorkspace` ran before this shell
    // existed, so end the shell here and don't resurrect the layout row that
    // the removal already deleted. Shells now outlive the server, so a stray
    // one would otherwise run until the next boot's reconcile.
    if (!workspaceService.resolve(workspaceId)) {
      await this.backend.kill(terminalId);
      throw new Error(`Workspace removed while its terminal was starting: ${workspaceId}`);
    }

    // Mirror what `createChat` and `createBrowser` do: register the new
    // terminal in the saved dockview layout so it survives a server
    // restart and renders the moment the workspace is opened. Without
    // this, terminals spawned via the WebSocket handler would be
    // invisible in the dashboard. `addPanel` is idempotent, so the tRPC
    // `create` path doesn't need a separate call.
    addTerminalToLayout(workspaceId, terminalId, {
      command: options?.command,
      cwd: options?.cwd,
      env: options?.env,
    });

    return entry;
  }

  /**
   * Kill a single terminal. Removes it from the saved dockview layout and
   * emits `terminal-killed` so the dashboard's status stream prunes the
   * panel. Safe to call with an unknown terminalId — no-op.
   */
  async kill(terminalId: string): Promise<void> {
    const killed = await this.backend.kill(terminalId);
    if (killed) {
      this.emitRemoved(killed.workspaceId, terminalId);
    }
  }

  /**
   * Drop a terminal from the saved dockview layout and broadcast
   * `terminal-killed` so an open dashboard prunes the panel. Shared by the
   * explicit {@link kill} path and the `cleanupOnExit` natural-exit path in
   * {@link handleExit}. Idempotent: `removeTerminalFromLayout` is a no-op when
   * the panel is already gone, and a duplicate `terminal-killed` is harmless.
   */
  private emitRemoved(workspaceId: string, terminalId: string): void {
    removeTerminalFromLayout(workspaceId, terminalId);
    emit({ kind: "terminal-killed", workspaceId, terminalId });
  }

  /**
   * A shell that exits on its own after being spawned with `cleanupOnExit`
   * gets the same teardown as an explicit kill. An explicit kill already ran
   * it in {@link kill}, so `killed` exits are skipped to avoid a double emit.
   */
  private handleExit(event: TerminalExitEvent): void {
    if (event.cleanupOnExit && !event.killed) {
      this.emitRemoved(event.workspaceId, event.terminalId);
    }
    for (const listener of this.exitListeners.get(event.terminalId) ?? []) {
      try {
        listener(event);
      } catch (err) {
        log.warn("terminal exit listener threw for %s: %s", event.terminalId, err);
      }
    }
  }

  /**
   * Kill every PTY associated with a workspace. Used by the workspace
   * deletion path — the caller is responsible for tearing down the layout
   * tree via {@link deleteLayout} as well.
   */
  killWorkspace(workspaceId: string): Promise<void> {
    return this.backend.killWorkspace(workspaceId);
  }

  /**
   * Kill sessions whose workspace no longer exists — it was deleted while
   * no server was running, so the `killWorkspace` in the delete path never
   * reached them. Runs once at boot. Only workspaces missing from the shared
   * `~/.band` state count, so a second server on the same home (dev beside
   * desktop) never kills the other's terminals.
   */
  async reconcile(): Promise<void> {
    const entries = await this.backend.listAll();
    // One kill per deleted workspace, not per terminal: each is a daemon round trip.
    const deleted = new Set(
      entries
        .map((entry) => entry.workspaceId)
        .filter((workspaceId) => !workspaceService.resolve(workspaceId)),
    );
    for (const workspaceId of deleted) {
      log.info({ workspaceId }, "killing terminals of a deleted workspace");
      await this.backend.killWorkspace(workspaceId);
    }
  }

  /** Release the backend at server shutdown — see `TerminalBackend.close`. */
  close(): Promise<void> {
    return this.backend.close();
  }

  // -------------------------------------------------------------------------
  // Per-terminal accessors
  // -------------------------------------------------------------------------

  list(workspaceId: string): Promise<TerminalListEntry[]> {
    return this.backend.list(workspaceId);
  }

  /** pid, foreground process name (`title`) and workspace, or `null` if not live. */
  info(terminalId: string): Promise<TerminalListEntry | null> {
    return this.backend.info(terminalId);
  }

  getScrollback(terminalId: string, lines?: number): Promise<string | null> {
    return this.backend.getScrollback(terminalId, lines);
  }

  /**
   * Snapshot plus live output from the point the snapshot was taken — the
   * replay-on-reconnect path. See `TerminalBackend.attach`.
   */
  attach(
    terminalId: string,
    dims?: { cols: number; rows: number },
  ): Promise<TerminalAttachment | null> {
    return this.backend.attach(terminalId, dims);
  }

  write(terminalId: string, data: string): Promise<boolean> {
    return this.backend.write(terminalId, data);
  }

  /** Keystrokes from a live terminal socket: fire-and-forget, ordered with {@link resize}. */
  input(terminalId: string, data: string): void {
    this.backend.input(terminalId, data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.backend.resize(terminalId, cols, rows);
  }

  /** Force a live TUI to repaint after re-attach — see `TerminalPool.nudgeResize`. */
  nudgeResize(terminalId: string): void {
    this.backend.nudgeResize(terminalId);
  }

  /**
   * Subscribe to one terminal's exit. Returns an unsubscribe function. Held
   * here rather than on the backend so it keeps working across
   * {@link setBackend}.
   */
  onExit(terminalId: string, listener: (event: TerminalExitEvent) => void): () => void {
    return addKeyed(this.exitListeners, terminalId, listener);
  }

  /**
   * Receive a terminal's foreground process name (its tab title) every few
   * seconds. Returns an unsubscribe function. See {@link TitlePoller}.
   */
  onTitle(terminalId: string, listener: (title: string) => void): () => void {
    return this.titles.watch(terminalId, listener);
  }

  /**
   * A terminal's snapshot, then its live output, then its exit, as one
   * async stream (the `terminal.stream` subscription). Yields `missing` and
   * ends if the terminal isn't live. Ends quietly when `signal` aborts.
   *
   * The exit subscription exists before the attach, so an exit landing in
   * between still ends the stream. Every wait re-checks the queue and flags
   * before parking, so an exit, chunk or abort that arrives while the
   * consumer holds the generator at a `yield` is seen, not slept through.
   */
  async *stream(terminalId: string, signal?: AbortSignal): AsyncGenerator<TerminalStreamEvent> {
    let exited = false;
    let wake: (() => void) | null = null;
    const notify = () => {
      const resolve = wake;
      wake = null;
      resolve?.();
    };
    const unsubscribeExit = this.onExit(terminalId, () => {
      exited = true;
      notify();
    });
    signal?.addEventListener("abort", notify);
    try {
      const attachment = await this.attach(terminalId);
      if (!attachment) {
        yield { kind: "missing" };
        return;
      }
      const queue: string[] = [];
      try {
        attachment.start((data) => {
          queue.push(data);
          notify();
        });
        yield { kind: "snapshot", data: attachment.snapshot };
        while (!signal?.aborted) {
          while (queue.length > 0) {
            yield { kind: "output", data: queue.shift()! };
          }
          if (exited) {
            yield { kind: "exit" };
            return;
          }
          await new Promise<void>((resolve) => {
            if (exited || queue.length > 0 || signal?.aborted) resolve();
            else wake = resolve;
          });
        }
      } finally {
        attachment.detach();
      }
    } finally {
      unsubscribeExit();
      signal?.removeEventListener("abort", notify);
    }
  }

  // -------------------------------------------------------------------------
  // Layout persistence (dockview tree)
  //
  // Only the workspace-deletion cleanup remains: `deleteLayout` drops the
  // saved `terminal_layout` row so a deleted workspace doesn't leak it. The
  // former get/save pass-throughs (which backed the `terminalLayout.*` tRPC
  // procedures) were retired in issue #643 Phase 4 once clients moved
  // center-layout persistence into localStorage. The spawn/kill paths still
  // register/unregister panels via `addTerminalToLayout` /
  // `removeTerminalFromLayout` so `getOrCreateDefault`-style lookups keep
  // working server-side.
  // -------------------------------------------------------------------------

  deleteLayout(workspaceId: string): void {
    deleteTerminalLayout(workspaceId);
  }

  // -------------------------------------------------------------------------
  // Workspace `.band/config.json` `workspace.terminal` block
  // -------------------------------------------------------------------------

  /**
   * Load and validate the `workspace.terminal` block from
   * `.band/config.json`. Returns `null` when the workspace can't be
   * resolved, the config file is absent, the block is missing, or the
   * payload fails validation.
   *
   * Absorbed from the old `lib/terminal-config.ts:loadWorkspaceTerminalConfig`
   * — same parsing semantics, but the lookup now goes through the service
   * tier so callers (currently the workspace router's `getTerminalConfig`
   * query) reach it via `terminalService` instead of a stand-alone helper.
   */
  getWorkspaceConfig(workspaceId: string): WorkspaceTerminalConfig | null {
    const workspace = workspaceService.resolve(workspaceId);
    if (!workspace) return null;
    return this.loadWorkspaceConfigFromPaths(workspace.worktree.path, workspace.project.path);
  }

  /**
   * Internal: the path-driven parse so tests / future non-tRPC entry
   * points can plug raw paths in without going through `resolveWorkspace`.
   */
  private loadWorkspaceConfigFromPaths(
    worktreePath: string,
    projectPath: string,
  ): WorkspaceTerminalConfig | null {
    const raw = loadProjectConfig(worktreePath, projectPath);
    if (!raw) return null;

    const terminalBlock =
      raw.workspace && typeof raw.workspace === "object"
        ? (raw.workspace as Record<string, unknown>).terminal
        : undefined;

    if (!terminalBlock) return null;

    const result = WorkspaceTerminalConfigSchema.safeParse(terminalBlock);
    if (!result.success) {
      log.warn(
        "Invalid workspace.terminal config: %s",
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
      return null;
    }

    return result.data;
  }
}

/** Add `listener` under `key`; the returned function removes it (and an emptied key). */
function addKeyed<T>(map: Map<string, Set<T>>, key: string, listener: T): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && map.get(key) === set) map.delete(key);
  };
}

/**
 * Process-wide singleton consumed by the API tier (terminals router +
 * terminal WS handler), the workspace cleanup paths, and `start-server.ts`.
 * Sharing one instance keeps the backend, the dockview layout writes, and the
 * event bus emissions in lock-step across every entry point.
 */
export const terminalService = new TerminalService();
