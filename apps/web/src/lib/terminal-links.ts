import { isDesktop } from "./is-desktop";
import { openExternalUrl } from "./open-external-url";

/** A plain click on a terminal URL asks the worktree's center layout for the link menu. */
export const TERMINAL_LINK_MENU_EVENT = "band:terminal-link-menu";

/** Asks the worktree's center layout to open a URL in a new Band browser tab. */
export const OPEN_IN_BAND_BROWSER_EVENT = "band:open-in-band-browser";

export interface TerminalLinkMenuDetail {
  worktreeId: string;
  /** The terminal the link was clicked in; the new tab goes next to its tab. */
  terminalId: string;
  url: string;
  /** Pointer position in viewport pixels, where the menu anchors. */
  x: number;
  y: number;
  /** Puts keyboard focus back in the terminal when the menu closes. */
  focusTerminal: () => void;
}

export interface OpenInBandBrowserDetail {
  worktreeId: string;
  terminalId?: string;
  url: string;
}

const isApple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Only web pages can load in a browser tab. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Whether the browser tab pane exists in this build. */
export function canOpenInBandBrowser(url: string): boolean {
  return isDesktop && isWebUrl(url);
}

export function openUrlInBandBrowser(detail: OpenInBandBrowserDetail): void {
  window.dispatchEvent(new CustomEvent(OPEN_IN_BAND_BROWSER_EVENT, { detail }));
}

/**
 * A click on a URL in a terminal. Cmd+click (Ctrl+click off macOS) opens the
 * Band browser, Shift+Cmd+click the system browser, and a plain click shows
 * the link menu. Without browser panes, or for a URL a tab can't load, the
 * Cmd+click opens the system browser and a plain click shows the menu.
 */
export function handleTerminalLinkClick(
  event: MouseEvent,
  url: string,
  target: Omit<TerminalLinkMenuDetail, "url" | "x" | "y">,
): void {
  const modifier = isApple ? event.metaKey : event.ctrlKey;
  if (!modifier) {
    window.dispatchEvent(
      new CustomEvent<TerminalLinkMenuDetail>(TERMINAL_LINK_MENU_EVENT, {
        detail: { ...target, url, x: event.clientX, y: event.clientY },
      }),
    );
    return;
  }
  if (event.shiftKey || !canOpenInBandBrowser(url)) {
    openExternalUrl(url);
    return;
  }
  openUrlInBandBrowser({ worktreeId: target.worktreeId, terminalId: target.terminalId, url });
}
