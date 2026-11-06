/**
 * What the embed page tells the app through `window.ReactNativeWebView.postMessage(JSON.stringify(...))`.
 * The page owns the editor's dirty state and Save; the app only needs the dirty flag, to ask before
 * Back discards edits. Anything else is ignored.
 */
export type PageMessage = { type: "dirty"; dirty: boolean };

export function parsePageMessage(data: string): PageMessage | null {
  try {
    const message = JSON.parse(data) as { type?: unknown; dirty?: unknown } | null;
    if (message?.type === "dirty") return { type: "dirty", dirty: message.dirty === true };
  } catch {
    // not JSON
  }
  return null;
}
