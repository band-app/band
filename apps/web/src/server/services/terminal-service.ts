import { createLogger } from "@band-app/logger";
import { z } from "zod";
import type { WorkspaceTerminalConfig } from "@/dashboard";
import {
  type SpawnOptions,
  type TerminalListEntry,
  type TerminalPool,
  type TerminalSession,
  terminalPool,
} from "../infra/terminals/terminal-pool";
import { loadProjectConfig } from "./project-config";
import {
  addTerminalToLayout,
  deleteTerminalLayout,
  getTerminalLayout,
  removeTerminalFromLayout,
  saveTerminalLayout,
} from "./terminal-layout-manager";
import { emit } from "./watcher";
import { resolveWorkspace } from "./workspace";

// Re-export the PTY types so the API tier (`terminals/router.ts`,
// `terminals/ws.ts`) can reference them without reaching into infra.
// Per `docs/web-architecture.md`, routers must go through services.
export type { SpawnOptions, TerminalListEntry, TerminalSession };

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
 * Services tier — coordinates the {@link TerminalPool} (PTY lifecycle), the
 * dockview layout store (so a freshly spawned terminal survives a reload),
 * and the workspace status event bus. The pool stays oblivious to the
 * workspace registry; the service is the one that resolves a workspaceId
 * to a worktree path and decides which side effects fire on spawn / kill.
 *
 * Callers:
 *   - The tRPC `terminals` router (`server/api/terminals/router.ts`) for
 *     synchronous CRUD-shaped procedures.
 *   - The terminal WebSocket handler (`server/api/terminals/ws.ts`) for
 *     spawning + attaching a live PTY.
 *   - The legacy `trpc/router.ts` workspaces flow, for `getTerminalConfig`
 *     and the workspace-deletion cleanup (`killWorkspace` + `deleteLayout`).
 *   - `start-server.ts` shutdown path, for `killAll`.
 *
 * Stateless aside from the `pool` dependency, which is itself a process-wide
 * singleton — see the `terminalService` export at the bottom.
 */
export class TerminalService {
  constructor(private readonly pool: TerminalPool = terminalPool) {}

  // -------------------------------------------------------------------------
  // PTY lifecycle
  // -------------------------------------------------------------------------

  /**
   * Spawn a new PTY for the given workspace + terminalId.
   *
   * Resolves `workspaceId` to a worktree path before delegating to the
   * pool, and registers the new terminal in the saved dockview layout so it
   * survives a server restart (mirrors `chatService.create` /
   * `browserService.create`). Does NOT emit a `terminal-created` event —
   * the API entry points decide whether to broadcast (the WebSocket handler
   * stays silent; the tRPC `create` mutation emits explicitly).
   */
  async spawn(
    workspaceId: string,
    terminalId: string,
    options?: SpawnOptions,
  ): Promise<TerminalSession> {
    const workspace = resolveWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    const session = await this.pool.spawn(
      workspaceId,
      terminalId,
      workspace.worktree.path,
      options,
    );

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

    return session;
  }

  /**
   * Kill a single terminal. Removes it from the saved dockview layout and
   * emits `terminal-killed` so the dashboard's status stream prunes the
   * panel. Safe to call with an unknown terminalId — no-op.
   */
  kill(terminalId: string): void {
    const session = this.pool.get(terminalId);
    const workspaceId = session?.workspaceId;
    this.pool.kill(terminalId);
    if (workspaceId) {
      removeTerminalFromLayout(workspaceId, terminalId);
      emit({ kind: "terminal-killed", workspaceId, terminalId });
    }
  }

  /**
   * Kill every PTY associated with a workspace. Used by the workspace
   * deletion path — the caller is responsible for tearing down the layout
   * tree via {@link deleteLayout} as well.
   */
  killWorkspace(workspaceId: string): void {
    this.pool.killWorkspace(workspaceId);
  }

  /**
   * Kill every tracked PTY across all workspaces. Used by the server
   * shutdown path in `start-server.ts`.
   */
  killAll(): void {
    this.pool.killAll();
  }

  // -------------------------------------------------------------------------
  // Per-terminal accessors
  // -------------------------------------------------------------------------

  list(workspaceId: string): TerminalListEntry[] {
    return this.pool.list(workspaceId);
  }

  getSession(terminalId: string): TerminalSession | undefined {
    return this.pool.get(terminalId);
  }

  getScrollback(terminalId: string, lines?: number): string | null {
    return this.pool.getScrollback(terminalId, lines);
  }

  write(terminalId: string, data: string): boolean {
    return this.pool.write(terminalId, data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.pool.resize(terminalId, cols, rows);
  }

  subscribeOutput(terminalId: string, callback: (data: string) => void): () => void {
    return this.pool.subscribeOutput(terminalId, callback);
  }

  // -------------------------------------------------------------------------
  // Layout persistence (dockview tree)
  //
  // Thin pass-throughs to `lib/terminal-layout-manager` so the API tier
  // doesn't reach across into `lib/` directly. The layout helpers will be
  // folded into a dedicated infra adapter in a follow-up phase (when the
  // chats/browsers domains get their own infra adapters); leaving them in
  // `lib/` for now is the minimum-disruption shape during the phased
  // migration.
  // -------------------------------------------------------------------------

  getLayout(workspaceId: string): unknown {
    return getTerminalLayout(workspaceId);
  }

  saveLayout(workspaceId: string, tree: unknown): void {
    saveTerminalLayout(workspaceId, tree);
  }

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
    const workspace = resolveWorkspace(workspaceId);
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

/**
 * Process-wide singleton consumed by the API tier (terminals router +
 * terminal WS handler), the legacy `trpc/router.ts` cleanup paths, and the
 * server-shutdown hook in `start-server.ts`. Sharing one instance keeps the
 * PTY pool, the dockview layout writes, and the event bus emissions in
 * lock-step across every entry point.
 */
export const terminalService = new TerminalService();
