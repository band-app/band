/**
 * IPC for the hub picker (Settings > Hub in the UI) and the synchronous config
 * read the preload makes on every page load.
 */

import { ipcMain } from "electron";
import { Channels, HUB_CONFIG_SYNC_CHANNEL } from "../../shared/ipc-channels.js";
import {
  checkRemoteHub,
  type HubChoice,
  type HubChoiceView,
  parseHubChoice,
  viewHubChoice,
} from "../services/hub-choice.js";

export interface HubIpcDeps {
  getChoice: () => HubChoice;
  /** Schedules the switch and returns true, or returns false while another switch runs. */
  switchTo: (choice: HubChoice) => boolean;
}

export type HubSetResult = { ok: true } | { ok: false; error: string };

/** `[channel, handler]` pairs for `registerIpc`'s `handle`, which checks the sender. */
export function hubHandlers(deps: HubIpcDeps): Array<[string, (args: unknown) => unknown]> {
  return [
    [
      Channels.hubGetChoice,
      (): HubChoiceView => {
        return viewHubChoice(deps.getChoice());
      },
    ],
    [
      Channels.hubSetChoice,
      async (args): Promise<HubSetResult> => {
        const parsed = parseHubChoice(args);
        if ("error" in parsed) return { ok: false, error: parsed.error };
        const { choice } = parsed;
        if (choice.mode === "remote") {
          const reachable = await checkRemoteHub(choice.url, choice.token);
          if (!reachable.ok) return reachable;
        }
        if (!deps.switchTo(choice)) {
          return {
            ok: false,
            error: "A hub switch is already in progress. Try again in a moment.",
          };
        }
        return { ok: true };
      },
    ],
  ];
}

/**
 * Answer the preload's `sendSync` with `{ url, token }`, or null for a sender
 * that isn't the main window's top frame on the bundled UI (a `<webview>` guest never runs this preload, but
 * the check keeps the token from ever reaching a page that happens to).
 */
export function registerHubConfigSync(
  getHub: () => { url: string; token?: string } | null,
  isTrusted: (event: Electron.IpcMainEvent) => boolean,
): () => void {
  const listener = (event: Electron.IpcMainEvent) => {
    event.returnValue = isTrusted(event) ? getHub() : null;
  };
  ipcMain.on(HUB_CONFIG_SYNC_CHANNEL, listener);
  return () => ipcMain.removeListener(HUB_CONFIG_SYNC_CHANNEL, listener);
}
