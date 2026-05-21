/**
 * Pure dispatcher for `band open` SSE events.
 *
 * Extracted from `__root.tsx` so it's testable in isolation. Given an
 * `open-file` event and the current layout, decides which side-effecting
 * handler to call:
 *
 *                  in-workspace            external
 *   ───────────────┼─────────────────────┼─────────────────────────────
 *   Desktop        │  onOpenFile         │  enqueue + onActivateFilesPanel
 *   Mobile / web   │  navigateInWorkspace│  enqueue + navigateToWorkspaceCode
 *
 * The two rendering models exist because:
 *   - Desktop dockview overlays the route Outlet and
 *     `DesktopWorkspaceLayout` returns null, so URL navigation alone
 *     never renders `CodeBrowserView`. Files are opened by writing into
 *     the per-workspace state store (via `crossPanelHandlers.onOpenFile`)
 *     and activating the Files panel.
 *   - Mobile/narrow web is purely URL-driven via TanStack routes; the
 *     `code/$splat` route mounts `CodeBrowserView` with the file in its
 *     props.
 *
 * External paths can't go in the URL (absolute paths corrupt the
 * back/forward stack), so they use a renderer-side queue regardless of
 * layout — see `lib/pending-external-open.ts`.
 */

import { enqueueExternalOpen } from "./pending-external-open";

export interface OpenFileDispatchHandlers {
  /**
   * Dockview path for in-workspace files. Writes
   * `currentFile`/`openFilePath` to the per-workspace state store AND
   * activates the Files panel. `filePath` may carry a
   * `:line[:col]` / `:line-end` suffix; the handler is responsible for
   * parsing.
   */
  onOpenFile: (workspaceId: string, filePath: string) => void;
  /**
   * Dockview path for external files. Activates the Files panel
   * without touching its current-file state (the actual file open is
   * driven by the pending-external-open queue, which the always-mounted
   * `CodeBrowserView` drains).
   */
  onActivateFilesPanel: (workspaceId: string) => void;
  /**
   * Mobile/web path for in-workspace files. Navigates to
   * `/workspace/$id/code/$splat` so the route mounts `CodeBrowserView`
   * with `file={_splat}`.
   */
  navigateInWorkspace: (workspaceId: string, filePath: string) => void;
  /**
   * Mobile/web path for external files. Navigates to
   * `/workspace/$id/code` so the index route mounts `CodeBrowserView`,
   * which drains the pending-external-open queue on mount.
   */
  navigateToWorkspaceCode: (workspaceId: string) => void;
}

export type OpenFileDispatchResult =
  | {
      handled: true;
      kind:
        | "dockview-in-workspace"
        | "dockview-external"
        | "mobile-in-workspace"
        | "mobile-external";
    }
  | { handled: false; reason: "not-open-file" | "missing-workspace-id" | "missing-file-path" };

/**
 * Decide how to handle an `open-file` SSE event. Pure-ish — the only
 * side effect outside the supplied handlers is the
 * `enqueueExternalOpen` write for external paths, which is part of the
 * dispatcher's contract (the renderer-side queue is the only place
 * absolute paths can live without corrupting routing state).
 *
 * Accepts the raw SSE payload shape (`Record<string, unknown>`) rather
 * than `StatusEvent` because the SSE stream is shared across all event
 * kinds and the listener fans out to this dispatcher for every event —
 * narrowing happens here, not at the call site.
 *
 * Returns a discriminated result so tests can assert which branch ran
 * without having to inspect spies. Callers in production ignore the
 * return value.
 */
export function dispatchOpenFileEvent(
  event: Record<string, unknown>,
  options: { isDockview: boolean; handlers: OpenFileDispatchHandlers },
): OpenFileDispatchResult {
  if (event.kind !== "open-file") return { handled: false, reason: "not-open-file" };
  const workspaceId = typeof event.workspaceId === "string" ? event.workspaceId : undefined;
  if (!workspaceId) return { handled: false, reason: "missing-workspace-id" };
  const filePath = typeof event.filePath === "string" ? event.filePath : undefined;
  if (!filePath) return { handled: false, reason: "missing-file-path" };

  const { isDockview, handlers } = options;

  if (event.external === true) {
    // External files: queue first (so a freshly-mounting CodeBrowserView
    // catches it on mount), then surface the Files panel / route.
    enqueueExternalOpen(workspaceId, filePath);
    if (isDockview) {
      handlers.onActivateFilesPanel(workspaceId);
      return { handled: true, kind: "dockview-external" };
    }
    handlers.navigateToWorkspaceCode(workspaceId);
    return { handled: true, kind: "mobile-external" };
  }

  if (isDockview) {
    handlers.onOpenFile(workspaceId, filePath);
    return { handled: true, kind: "dockview-in-workspace" };
  }
  handlers.navigateInWorkspace(workspaceId, filePath);
  return { handled: true, kind: "mobile-in-workspace" };
}
