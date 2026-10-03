/**
 * The sender check every privileged IPC channel goes through. `registerIpc`
 * wraps each handler with `guardedHandler`, so a new channel gets the check
 * without remembering to ask for it.
 *
 * Imports Electron types only, so tests need no Electron.
 */

import { isTrustedUiUrl } from "../navigation-guard.js";

/** The parts of an IPC event the check reads. */
export interface SenderEvent {
  sender: unknown;
  senderFrame: { url: string } | null;
}

export interface SenderWindow {
  isDestroyed(): boolean;
  webContents: { mainFrame: unknown };
}

/**
 * The main window's top frame, showing a page on a trusted `app://` origin. A
 * `<webview>` guest, a subframe and any other window are refused.
 */
export function isTrustedSender(
  event: SenderEvent,
  mainWindow: SenderWindow,
  trustedOrigins: readonly string[],
): boolean {
  const frame = event.senderFrame;
  return (
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame === (event.sender as { mainFrame: unknown }).mainFrame &&
    isTrustedUiUrl(frame.url, trustedOrigins)
  );
}

/** Wraps a channel handler so it throws for an untrusted sender before running. */
export function guardedHandler<E extends SenderEvent, A, R>(
  isTrusted: (event: E) => boolean,
  fn: (args: A, event: E) => R,
): (event: E, args: A) => R {
  return (event, args) => {
    if (!isTrusted(event)) throw new Error("Not allowed from this frame");
    return fn(args, event);
  };
}
