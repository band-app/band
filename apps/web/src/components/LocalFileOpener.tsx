import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useEffect, useRef } from "react";
import { useCapabilities, useDashboardStore, useRepos } from "../dashboard";
import { type LocalWorktree, planLocalFileOpen } from "../dashboard/lib/local-file-target";
import { listen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import {
  type LocalOpenRequest,
  OPEN_LOCAL_FILES_EVENT,
  takeOsOpenFiles,
  thisMachineHostIds,
} from "../lib/open-local-files";
import { getWorktreeLeafActions } from "./WorktreeCenter";

/** How long to wait for a worktree's layout to mount after switching to it. */
const LAYOUT_WAIT_MS = 5_000;

async function waitForLeafActions(worktreeId: string) {
  const deadline = Date.now() + LAYOUT_WAIT_MS;
  for (;;) {
    const actions = getWorktreeLeafActions(worktreeId);
    if (actions) return actions;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Opens files that live on this Mac (desktop app only): paths the OS handed
 * the app, files dragged from Finder, the Open File picker. A file inside a
 * worktree on this Mac switches to that worktree and opens as a normal tab. Any
 * other file opens as an external tab in the current worktree, read and saved
 * by the desktop app. Renders nothing.
 */
export function LocalFileOpener({ activeWorktreeId }: { activeWorktreeId: string | null }) {
  const { repos, isLoading: reposLoading } = useRepos();
  const capabilities = useCapabilities();
  const openWorktree = useDashboardStore((s) => s.openWorktree);
  const notify = useDashboardStore((s) => s.notify);

  // The handlers outlive renders, so they read the latest values through a ref.
  const latest = useRef({
    repos,
    reposLoading,
    activeWorktreeId,
    capabilities,
    openWorktree,
    notify,
  });
  latest.current = { repos, reposLoading, activeWorktreeId, capabilities, openWorktree, notify };

  useEffect(() => {
    let queue = Promise.resolve();

    const openOne = async ({ path, line, column, directory }: LocalOpenRequest) => {
      // A cold start from Finder queues paths before the worktree list exists. Wait for it, or a
      // file inside a worktree would open as an external tab.
      const loadDeadline = Date.now() + LAYOUT_WAIT_MS;
      while (latest.current.reposLoading && Date.now() < loadDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const cur = latest.current;
      const worktrees: LocalWorktree[] = cur.repos.flatMap((repo) =>
        repo.worktrees.map((wt) => ({
          id: toWorktreeId(repo.name, wt.name, wt.hostId),
          path: wt.path,
          hostId: wt.hostId,
        })),
      );
      const plan = planLocalFileOpen(
        path,
        worktrees,
        await thisMachineHostIds(),
        cur.activeWorktreeId,
        directory,
      );
      if (plan.kind === "outside") {
        cur.notify("info", plan.message);
        return;
      }
      if (plan.kind === "select") {
        if (plan.worktreeId !== cur.activeWorktreeId) {
          const href = cur.capabilities.getWorktreeHref?.(plan.worktreeId);
          if (href && cur.capabilities.navigate) cur.capabilities.navigate(href);
          else cur.openWorktree(plan.worktreeId);
        }
        return;
      }
      if (plan.kind === "none") {
        cur.notify("info", plan.reason);
        return;
      }
      if (plan.kind === "worktree") {
        if (plan.worktreeId !== cur.activeWorktreeId) {
          const href = cur.capabilities.getWorktreeHref?.(plan.worktreeId);
          if (href && cur.capabilities.navigate) cur.capabilities.navigate(href);
          else cur.openWorktree(plan.worktreeId);
        }
        const actions = await waitForLeafActions(plan.worktreeId);
        if (!actions) cur.notify("info", `Couldn't open ${path}`);
        actions?.openFile(plan.relPath, { preview: false, line, column });
        return;
      }
      const actions = await waitForLeafActions(plan.worktreeId);
      if (!actions) cur.notify("info", `Couldn't open ${path}`);
      actions?.openFile(path, { source: "desktop", preview: false, line, column });
    };

    // One file at a time, in arrival order: a switch of worktree finishes before the next file.
    const enqueue = (requests: LocalOpenRequest[]) => {
      for (const request of requests) {
        queue = queue
          .then(() => openOne(request))
          .catch(() => {
            latest.current.notify("info", `Couldn't open ${request.path}`);
          });
      }
    };

    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<{ paths?: string[] }>).detail;
      enqueue((detail?.paths ?? []).map((path) => ({ path })));
    };
    window.addEventListener(OPEN_LOCAL_FILES_EVENT, onRequest);

    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (isDesktop) {
      const drain = () => void takeOsOpenFiles().then(enqueue);
      void listen("open-files-requested", drain).then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        // Paths queued before this page could listen (a cold start from Finder). Draining after
        // the listener exists means a path pushed meanwhile is either drained here or announced.
        drain();
      });
    }
    return () => {
      disposed = true;
      window.removeEventListener(OPEN_LOCAL_FILES_EVENT, onRequest);
      unlisten?.();
    };
  }, []);

  return null;
}
