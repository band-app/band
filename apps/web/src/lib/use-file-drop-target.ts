import { type DragEvent, useCallback, useState } from "react";
import { isDesktop } from "./is-desktop";
import { pathsFromDrop, requestOpenLocalFiles } from "./open-local-files";

export const FOLDER_DROP_NOTICE = "Folders can't be opened in a tab. Drop a file instead.";

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/**
 * Makes an element open files dragged from the file manager as tabs. Only the
 * desktop app can read a dropped file's path, so in a browser the element is
 * not a drop target and the drop does nothing (the window-level handler in
 * `client.tsx` still stops the browser from navigating to the file).
 */
export function useFileDropTarget(notify: (message: string) => void) {
  const [over, setOver] = useState(false);

  const onDragOver = useCallback((e: DragEvent) => {
    if (!isDesktop || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setOver(true);
  }, []);

  const onDragLeave = useCallback(() => setOver(false), []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      setOver(false);
      if (!isDesktop || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const { paths, folders } = pathsFromDrop(e.dataTransfer);
      if (folders > 0) notify(FOLDER_DROP_NOTICE);
      requestOpenLocalFiles(paths);
    },
    [notify],
  );

  return { over, handlers: { onDragOver, onDragLeave, onDrop } };
}
