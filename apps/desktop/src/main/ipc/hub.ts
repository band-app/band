/**
 * IPC for the hub picker (Settings > Hub in the UI) and the synchronous config
 * read the preload makes on every page load.
 */

import { ipcMain } from "electron";
import { Channels, HUB_CONFIG_SYNC_CHANNEL } from "../../shared/ipc-channels.js";
import { APP_ORIGIN } from "../app-protocol.js";
import {
  checkRemoteHub,
  type HubChoice,
  type HubChoiceView,
  parseHubChoice,
  viewHubChoice,
} from "../services/hub-choice.js";

export interface HubIpcDeps {
  getChoice: () => HubChoice;
  /** Save the choice and reload the window against it. Resolves once the switch is under way. */
  switchTo: (choice: HubChoice) => void;
}

export type HubSetResult = { ok: true } | { ok: false; error: string };

/** `[channel, handler]` pairs for `registerIpc`'s `handle`. */
export function hubHandlers(deps: HubIpcDeps): Array<[string, (args: unknown) => unknown]> {
  return [
    [Channels.hubGetChoice, (): HubChoiceView => viewHubChoice(deps.getChoice())],
    [
      Channels.hubSetChoice,
      async (args: unknown): Promise<HubSetResult> => {
        const parsed = parseHubChoice(args);
        if ("error" in parsed) return { ok: false, error: parsed.error };
        const { choice } = parsed;
        if (choice.mode === "remote") {
          const reachable = await checkRemoteHub(choice.url, choice.token);
          if (!reachable.ok) return reachable;
        }
        deps.switchTo(choice);
        return { ok: true };
      },
    ],
  ];
}

/** Whether a frame URL belongs to the UI this app serves, and may be told the hub's token. */
export function isTrustedUiUrl(frameUrl: string | undefined, devUrl: string | null): boolean {
  if (!frameUrl) return false;
  try {
    const origin = new URL(frameUrl).origin;
    return origin === APP_ORIGIN || (devUrl !== null && origin === new URL(devUrl).origin);
  } catch {
    return false;
  }
}

/**
 * Answer the preload's `sendSync` with `{ url, token }`, or null for a frame
 * that isn't the bundled UI (a `<webview>` guest never runs this preload, but
 * the check keeps the token from ever reaching a page that happens to).
 */
export function registerHubConfigSync(
  getHub: () => { url: string; token?: string } | null,
  devUrl: string | null,
): () => void {
  const listener = (event: Electron.IpcMainEvent) => {
    event.returnValue = isTrustedUiUrl(event.senderFrame?.url, devUrl) ? getHub() : null;
  };
  ipcMain.on(HUB_CONFIG_SYNC_CHANNEL, listener);
  return () => ipcMain.removeListener(HUB_CONFIG_SYNC_CHANNEL, listener);
}
