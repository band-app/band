import { ACCEPTED_MEDIA_TYPES } from "@band-app/client/composer";
import { invoke, pathForDroppedFile } from "./desktop-ipc";
import { localWorkerId } from "./direct-worker";
import { isDesktop } from "./is-desktop";
import { trpc } from "./trpc-client";

/** Extensions whose media type a browser or OS may leave empty or generic. */
const ATTACHABLE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "xml",
  "yaml",
  "yml",
]);

/** True when the drag carries files (not text or a sidebar row). */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}

/** Whether the composer's paperclip would accept this file. */
export function isAttachable(file: File): boolean {
  if (ACCEPTED_MEDIA_TYPES.includes(file.type)) return true;
  const dot = file.name.lastIndexOf(".");
  return dot > 0 && ATTACHABLE_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase());
}

export const BROWSER_DROP_NOTICE =
  "Only images, PDFs and text files can be dropped in a browser. Use the desktop app to drop other files.";

/** The worker id named by a worktree id (`<repo>-<branch>@<hostId>`), or null for the hub's own machine. */
function hostOfWorktree(worktreeId: string): string | null {
  const at = worktreeId.lastIndexOf("@");
  return at >= 0 ? worktreeId.slice(at + 1) : null;
}

/** Whether the worktree lives on the machine the desktop app runs on. */
export async function worktreeIsOnThisMachine(worktreeId: string): Promise<boolean> {
  if (!isDesktop) return false;
  const host = hostOfWorktree(worktreeId);
  const mine = await localWorkerId();
  if (host) return mine === host;
  // No suffix: the hub's own machine, which is this one only when the app runs the hub itself.
  try {
    const choice = await invoke<{ mode: "local" | "remote" }>("hub_get_choice");
    return choice.mode === "local";
  } catch {
    return false;
  }
}

async function workerName(worktreeId: string): Promise<string> {
  // A worktree id with no suffix is on the hub's own machine, the worker `local`.
  const host = hostOfWorktree(worktreeId) ?? "local";
  try {
    const { hosts } = await trpc.workers.list.query();
    return hosts.find((h) => h.id === host)?.name ?? host;
  } catch {
    return host;
  }
}

export interface DropPlan {
  attach: File[];
  /** Absolute paths to insert into the message, in drop order. */
  paths: string[];
  /** A short message for the composer's notice line, or null. */
  notice: string | null;
}

/** Decides what each dropped file becomes. */
export async function planDrop(files: File[], worktreeId: string | undefined): Promise<DropPlan> {
  const attach: File[] = [];
  const others: File[] = [];
  for (const file of files) (isAttachable(file) ? attach : others).push(file);
  if (others.length === 0) return { attach, paths: [], notice: null };

  const paths = others.map((f) => pathForDroppedFile(f)).filter((p): p is string => !!p);
  if (paths.length === 0) return { attach, paths: [], notice: BROWSER_DROP_NOTICE };

  if (worktreeId && (await worktreeIsOnThisMachine(worktreeId))) {
    return { attach, paths, notice: null };
  }
  const name = worktreeId ? await workerName(worktreeId) : "another worker";
  return {
    attach,
    paths: [],
    notice: `That file is on this machine, but this worktree is on ${name}. Only images, PDFs and text files can be attached.`,
  };
}
