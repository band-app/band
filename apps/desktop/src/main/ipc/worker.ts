/** IPC for "this computer as a worker" (the first-run prompt and Settings > Hosts). */

import { Channels } from "../../shared/ipc-channels.js";
import type { ThisComputerAddArgs, ThisComputerResult } from "../../shared/types.js";
import type { HubAccess, ThisComputerWorker } from "../services/this-computer-worker.js";

export interface WorkerIpcDeps {
  worker: ThisComputerWorker;
  /** The remote hub and the admin token the app holds for it, or null with the local hub. */
  getHub: () => HubAccess | null;
}

const NO_HUB: ThisComputerResult = {
  ok: false,
  error: "Connect to a remote hub first. The local hub already runs on this computer.",
};

/** `[channel, handler]` pairs for `registerIpc`'s `handle`, which checks the sender. */
export function workerHandlers(deps: WorkerIpcDeps): Array<[string, (args: unknown) => unknown]> {
  return [
    [Channels.workerStatus, () => deps.worker.status(deps.getHub())],
    [
      Channels.workerAdd,
      async (args): Promise<ThisComputerResult> => {
        const hub = deps.getHub();
        if (!hub) return NO_HUB;
        const input = (args && typeof args === "object" ? args : {}) as ThisComputerAddArgs;
        return deps.worker.add(hub, {
          name: typeof input.name === "string" ? input.name : undefined,
          roots: Array.isArray(input.roots) ? input.roots : [],
        });
      },
    ],
    [Channels.workerRemove, (): Promise<ThisComputerResult> => deps.worker.remove(deps.getHub())],
    [
      Channels.workerSwitchBundled,
      (): Promise<ThisComputerResult> => deps.worker.switchToBundled(deps.getHub()),
    ],
    [
      Channels.workerDismissPrompt,
      (): void => {
        const hub = deps.getHub();
        if (hub) deps.worker.markAnswered(hub.url);
      },
    ],
  ];
}
