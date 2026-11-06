/**
 * Files on this Mac that should open in Band: Finder's Open With, a drag from
 * Finder onto a tab strip, the Open File picker. Callers hand absolute paths
 * to `requestOpenLocalFiles`; `LocalFileOpener` decides where each one opens
 * (see `planLocalFileOpen`). Only the desktop app has such paths.
 */

import { invoke, pathForDroppedFile } from "./desktop-ipc";
import { localWorkerId } from "./direct-worker";
import { isDesktop } from "./is-desktop";

export const OPEN_LOCAL_FILES_EVENT = "band:open-local-files";

export function requestOpenLocalFiles(paths: string[]): void {
  if (paths.length === 0) return;
  window.dispatchEvent(new CustomEvent(OPEN_LOCAL_FILES_EVENT, { detail: { paths } }));
}

/** Ids of the workers that run on this Mac: its own worker, and `local` when the app runs the hub. */
export async function thisMachineHostIds(): Promise<string[]> {
  if (!isDesktop) return [];
  const ids: string[] = [];
  const mine = await localWorkerId();
  if (mine) ids.push(mine);
  try {
    const choice = await invoke<{ mode: "local" | "remote" }>("hub_get_choice");
    if (choice.mode === "local") ids.push("local");
  } catch {
    // Not a desktop shell that knows the hub choice: only the worker id counts.
  }
  return ids;
}

/** Paths the OS handed the app before the page could listen. Empties the queue. */
export async function takeOsOpenFiles(): Promise<string[]> {
  if (!isDesktop) return [];
  try {
    return await invoke<string[]>("take_open_files");
  } catch {
    return [];
  }
}

export interface DroppedFiles {
  /** Absolute paths of the dropped files, in drop order. */
  paths: string[];
  /** How many dropped items were folders, which are not opened. */
  folders: number;
}

/**
 * The paths in a file drop. A browser gives no path, so it yields none and the
 * drop does nothing. Folders are counted, not opened.
 */
export function pathsFromDrop(dt: DataTransfer): DroppedFiles {
  const paths: string[] = [];
  let folders = 0;
  const files = Array.from(dt.files);
  // `dt.items` also holds string items, so pair the files with the file items only.
  const items = Array.from(dt.items).filter((it) => it.kind === "file");
  files.forEach((file, i) => {
    const entry = items[i]?.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      folders++;
      return;
    }
    const path = pathForDroppedFile(file);
    if (path) paths.push(path);
  });
  return { paths, folders };
}
