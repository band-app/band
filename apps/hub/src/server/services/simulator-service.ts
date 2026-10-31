import { CENTER_TABS_PREFIX } from "@band-app/shared/client-state-keys";
import { ClientStateQueries } from "../infra/db/queries/client-state";
import { clientStateService } from "./client-state-service";
import { pluginHost } from "./plugin-host-service";
import { worktreeService } from "./worktree-service";

export const SIMULATOR_PLUGIN = "simulator";
/** The id of the Simulator tab. A worktree has one. */
export const SIMULATOR_TAB_ID = "plugin:simulator:simulator";

export interface SimulatorStatus {
  /** The worktree's worker is online and can run a simulator. */
  available: boolean;
  /** Why not, when `available` is false. */
  reason?: string;
  hostId: string;
  device?: {
    udid: string;
    name: string;
    state: string;
    screen: { width: number; height: number } | null;
  };
}

/** The Simulator tab's server side: what the worktree's worker offers, and opening the tab. */
export class SimulatorService {
  private readonly queries = new ClientStateQueries();

  async status(worktreeId: string): Promise<SimulatorStatus> {
    const resolved = worktreeService.resolve(worktreeId);
    if (!resolved) throw new Error(`Worktree ${worktreeId} does not exist`);
    const hostId = resolved.host.id;
    if (!resolved.host.plugins) {
      return {
        available: false,
        hostId,
        reason:
          "The hub's own machine runs no simulator. Use a worktree on a connected Mac worker.",
      };
    }
    const info = await resolved.host.info().catch(() => null);
    if (!info) return { available: false, hostId, reason: `Worker ${hostId} is offline` };
    if (!info.capabilities[SIMULATOR_PLUGIN]) {
      return {
        available: false,
        hostId,
        reason: `Worker ${hostId} has no iOS simulator (it needs a Mac with Xcode)`,
      };
    }
    const device = (await pluginHost.callForWorktree(
      SIMULATOR_PLUGIN,
      worktreeId,
      "status",
    )) as NonNullable<SimulatorStatus["device"]>;
    return { available: true, hostId, device };
  }

  /** Boots the device and puts the tab in the shared list. */
  async open(worktreeId: string): Promise<SimulatorStatus> {
    const status = await this.status(worktreeId);
    if (!status.available) throw new Error(status.reason ?? "No simulator here");
    await pluginHost.callForWorktree(SIMULATOR_PLUGIN, worktreeId, "boot");
    this.addTab(worktreeId);
    return this.status(worktreeId);
  }

  /** Adds the tab to `band:center-tabs:<id>` and makes it the active one. */
  private addTab(worktreeId: string): void {
    const key = `${CENTER_TABS_PREFIX}${worktreeId}`;
    const row = this.queries.find(key, "all");
    let tabs: { tabs: Array<{ id: string; kind: string }>; active: string | null } = {
      tabs: [],
      active: null,
    };
    const parsed = row?.value as typeof tabs | null | undefined;
    // An unreadable list is replaced by one that holds the tab.
    if (parsed && Array.isArray(parsed.tabs)) tabs = parsed;
    if (!tabs.tabs.some((t) => t.id === SIMULATOR_TAB_ID)) {
      tabs.tabs.push({ id: SIMULATOR_TAB_ID, kind: "plugin" });
    }
    tabs.active = SIMULATOR_TAB_ID;
    clientStateService.set({
      key,
      scope: "all",
      value: tabs,
      baseVersion: row?.version ?? 0,
      clientId: "hub",
    });
  }
}

export const simulatorService = new SimulatorService();
