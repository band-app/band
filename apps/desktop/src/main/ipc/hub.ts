/**
 * IPC for the hub picker (Settings > Hub in the UI) and the synchronous config
 * read the preload makes on every page load.
 */

import { ipcMain } from "electron";
import { Channels, HUB_CONFIG_SYNC_CHANNEL } from "../../shared/ipc-channels.js";
import { isTrustedUiUrl } from "../navigation-guard.js";
import {
  checkRemoteHub,
  type HubChoice,
  type HubChoiceView,
  parseHubChoice,
  viewHubChoice,
} from "../services/hub-choice.js";

export interface HubIpcDeps {
  /** True only for the main window's top frame, showing the bundled UI. */
  isTrustedSender: (event: Electron.IpcMainInvokeEvent) => boolean;
  getChoice: () => HubChoice;
  /** Schedules the switch. The reload runs after the IPC reply. */
  switchTo: (choice: HubChoice) => void;
}

export type HubSetResult = { ok: true } | { ok: false; error: string };

/** `[channel, handler]` pairs for `registerIpc`'s `handle`. */
export function hubHandlers(
  deps: HubIpcDeps,
): Array<[string, (args: unknown, event: Electron.IpcMainInvokeEvent) => unknown]> {
  const guard = (event: Electron.IpcMainInvokeEvent) => {
    if (!deps.isTrustedSender(event)) throw new Error("Not allowed from this frame");
  };
  return [
    [
      Channels.hubGetChoice,
      (_args, event): HubChoiceView => {
        guard(event);
        return viewHubChoice(deps.getChoice());
      },
    ],
    [
      Channels.hubSetChoice,
      async (args, event): Promise<HubSetResult> => {
        guard(event);
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

/** The main window's top frame, showing a trusted page: the only caller the hub IPC accepts. */
export function isTrustedSender(
  event: Electron.IpcMainInvokeEvent,
  mainWindow: Electron.BrowserWindow,
  trustedOrigins: readonly string[],
): boolean {
  const frame = event.senderFrame;
  return (
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame === event.sender.mainFrame &&
    isTrustedUiUrl(frame.url, trustedOrigins)
  );
}

/**
 * Answer the preload's `sendSync` with `{ url, token }`, or null for a frame
 * that isn't the bundled UI (a `<webview>` guest never runs this preload, but
 * the check keeps the token from ever reaching a page that happens to).
 */
export function registerHubConfigSync(
  getHub: () => { url: string; token?: string } | null,
  getTrustedOrigins: () => readonly string[],
): () => void {
  const listener = (event: Electron.IpcMainEvent) => {
    event.returnValue = isTrustedUiUrl(event.senderFrame?.url, getTrustedOrigins())
      ? getHub()
      : null;
  };
  ipcMain.on(HUB_CONFIG_SYNC_CHANNEL, listener);
  return () => ipcMain.removeListener(HUB_CONFIG_SYNC_CHANNEL, listener);
}
