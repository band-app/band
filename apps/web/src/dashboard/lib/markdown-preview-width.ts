import { useCallback, useEffect, useState } from "react";
import { clientStorage } from "../../lib/client-state";

/**
 * How wide the rendered markdown preview lays out its text: `narrow` is a
 * centered column, `full` uses the whole pane. One global choice, kept on the
 * server per device type (`shared/client-state-keys.ts`), so a full-width
 * preview on a wide desktop doesn't change the phone.
 */
export type MarkdownPreviewWidth = "narrow" | "full";

const MARKDOWN_PREVIEW_WIDTH_KEY = "band:markdown-preview-width";

const CHANGE_EVENT = "band:markdown-preview-width-change";

function readMarkdownPreviewWidth(): MarkdownPreviewWidth {
  try {
    if (localStorage.getItem(MARKDOWN_PREVIEW_WIDTH_KEY) === "full") return "full";
  } catch {}
  return "narrow";
}

function writeMarkdownPreviewWidth(width: MarkdownPreviewWidth): void {
  clientStorage.setItem(MARKDOWN_PREVIEW_WIDTH_KEY, width);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/**
 * The current width and a setter. Every preview on the page follows a change
 * right away; another device's change arrives as a `storage` event.
 */
export function useMarkdownPreviewWidth(): [
  MarkdownPreviewWidth,
  (width: MarkdownPreviewWidth) => void,
] {
  const [width, setWidth] = useState(readMarkdownPreviewWidth);

  useEffect(() => {
    const sync = () => setWidth(readMarkdownPreviewWidth());
    // Other devices' writes to any synced key arrive as storage events, many
    // per second while someone types; only this key matters here.
    const onStorage = (e: StorageEvent) => {
      if (e.key === MARKDOWN_PREVIEW_WIDTH_KEY || e.key === null) sync();
    };
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const set = useCallback((value: MarkdownPreviewWidth) => {
    writeMarkdownPreviewWidth(value);
    setWidth(value);
  }, []);

  return [width, set];
}
