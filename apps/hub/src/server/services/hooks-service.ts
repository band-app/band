import { hostRegistry } from "../infra/host/registry";

/**
 * Whether Band's hooks are in the local host's Claude Code settings. Reads and
 * writes happen on the host (`host.agentEnv`), so a remote host's hooks are
 * its own.
 */
export function checkHooks() {
  return hostRegistry.local.agentEnv.hooksStatus();
}

export function installHooks(): Promise<void> {
  return hostRegistry.local.agentEnv.installHooks();
}
