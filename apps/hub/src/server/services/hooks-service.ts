import type { HooksStatus } from "@band-app/host-api";

import { hostRegistry } from "../infra/host/registry";
import { tokenService } from "./token-service";

const LOCAL_HOST_ID = "local";

/** One host's Claude Code hooks, for Settings > Agent hooks and the install banner. */
export interface HostHooksView {
  hostId: string;
  name: string;
  online: boolean;
  /** Whether Claude Code can start on the host. */
  hasClaudeCode: boolean;
  /** Null when the host is offline or could not be read; `error` says why. */
  status: HooksStatus | null;
  error?: string;
}

/**
 * Band's hooks live in each host's own `~/.claude/settings.json`, so every
 * call here goes to a host (`host.agentEnv`). Nothing installs on its own: a
 * person asks for it per host.
 */
function hostOf(hostId: string) {
  return hostRegistry.hostById(hostId);
}

export function checkHooks(hostId: string = LOCAL_HOST_ID) {
  return hostOf(hostId).agentEnv.hooksStatus();
}

export function installHooks(hostId: string = LOCAL_HOST_ID): Promise<void> {
  return hostOf(hostId).agentEnv.installHooks();
}

export function removeHooks(hostId: string = LOCAL_HOST_ID): Promise<void> {
  return hostOf(hostId).agentEnv.removeHooks();
}

async function claudeCodeOn(hostId: string, agents: string[]): Promise<boolean> {
  if (hostId !== LOCAL_HOST_ID) return agents.includes("claude-code");
  try {
    return typeof (await hostOf(hostId).acp.resolveLaunch({ type: "claude-code" })) !== "string";
  } catch {
    return false;
  }
}

/** The hooks of every usable host. An offline host has no status. */
export async function listHostHooks(): Promise<HostHooksView[]> {
  const hosts = tokenService.listHosts().filter((h) => h.id !== LOCAL_HOST_ID || h.usable);
  return Promise.all(
    hosts.map(async (h): Promise<HostHooksView> => {
      const online = h.id === LOCAL_HOST_ID || h.status === "online";
      const view: HostHooksView = {
        hostId: h.id,
        name: h.name,
        online,
        hasClaudeCode: await claudeCodeOn(h.id, h.agents),
        status: null,
      };
      if (!online) return view;
      try {
        view.status = await checkHooks(h.id);
      } catch (err) {
        view.error = err instanceof Error ? err.message : String(err);
      }
      return view;
    }),
  );
}
