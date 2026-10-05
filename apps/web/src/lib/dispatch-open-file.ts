/**
 * Pure dispatcher for `band open` SSE events on the desktop dockview.
 *
 * Extracted from `__root.tsx` so it's testable in isolation. Given an
 * `open-file` event, decides which side-effecting handler to call:
 *
 *   in-worktree   →  onOpenFile
 *   external       →  enqueue + onActivateFilesPanel
 *
 * Mobile / narrow web is handled by the caller — it short-circuits before
 * reaching the dispatcher (see `__root.tsx`). Rationale: post the route-
 * unification refactor (issue #467) the mobile worktree layout's active
 * tab and selected file live entirely in local React state, so an
 * open-file event has nowhere to land on mobile. `band open` is a
 * desktop developer affordance.
 */

import { enqueueExternalOpen } from "./pending-external-open";

export interface OpenFileDispatchHandlers {
  /**
   * Dockview path for in-worktree files. Writes
   * `currentFile`/`openFilePath` to the per-worktree state store AND
   * activates the Files panel. `filePath` may carry a
   * `:line[:col]` / `:line-end` suffix; the handler is responsible for
   * parsing.
   */
  onOpenFile: (worktreeId: string, filePath: string) => void;
  /**
   * Dockview path for external files. Activates the Files panel
   * without touching its current-file state (the actual file open is
   * driven by the pending-external-open queue, which the always-mounted
   * `CodeBrowserView` drains).
   */
  onActivateFilesPanel: (worktreeId: string) => void;
}

export type OpenFileDispatchResult =
  | { handled: true; kind: "in-worktree" | "external" }
  | {
      handled: false;
      reason: "not-open-file" | "missing-worktree-id" | "missing-file-path";
    };

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
  handlers: OpenFileDispatchHandlers,
): OpenFileDispatchResult {
  if (event.kind !== "open-file") return { handled: false, reason: "not-open-file" };
  const worktreeId = typeof event.worktreeId === "string" ? event.worktreeId : undefined;
  if (!worktreeId) return { handled: false, reason: "missing-worktree-id" };
  const filePath = typeof event.filePath === "string" ? event.filePath : undefined;
  if (!filePath) return { handled: false, reason: "missing-file-path" };

  if (event.external === true) {
    // External files: queue first (so a freshly-mounting CodeBrowserView
    // catches it on mount), then surface the Files panel.
    enqueueExternalOpen(worktreeId, filePath);
    handlers.onActivateFilesPanel(worktreeId);
    return { handled: true, kind: "external" };
  }

  handlers.onOpenFile(worktreeId, filePath);
  return { handled: true, kind: "in-worktree" };
}
