/**
 * Whether an agent on one host may start a worktree on another. The relay (`relay-scope.ts`) and
 * the built-in `band` MCP server both ask here, so a `band worktrees create --host B` and a
 * `worktrees_create` tool call get the same answer. The repo's allowed-host rule (#858) is
 * enforced again by `WorktreeService.create`; it is checked here too so the refusal names the
 * reason before anything runs.
 */

import { isHostAllowed, onlyAvailableOnMessage } from "@band-app/shared/repo-hosts";
import { RunnerMachineQueries } from "../infra/db/queries/runner-machines";
import { allowedHostsOf, hostNamesOf } from "./_utils/repo-host-policy";
import { settingsService } from "./settings-service";
import { tokenService } from "./token-service";

const runnerMachines = new RunnerMachineQueries();

/** `agents.crossHostWorktrees` in settings.json. On unless it is set to false. */
export function crossHostWorktreesEnabled(): boolean {
  return settingsService.get().agents?.crossHostWorktrees !== false;
}

/**
 * A message saying why an agent on `callerHostId` cannot create a worktree of `repo` on
 * `targetHostId`, or null when it may. A target equal to the caller's host is always fine.
 */
export function crossHostRefusal(
  repo: string,
  targetHostId: string,
  callerHostId: string,
): string | null {
  if (targetHostId === callerHostId) return null;
  if (!crossHostWorktreesEnabled()) {
    return "Agents may not start worktrees on other hosts. An admin can turn this on in Settings > Agents.";
  }
  if (targetHostId === "local") {
    return "Agents on a worker cannot start worktrees on the hub's own machine";
  }
  const host = tokenService.listHosts(1000).find((h) => h.id === targetHostId);
  if (!host) return `No host "${targetHostId}"`;
  if (host.mode === "ephemeral" || host.info?.mode === "ephemeral") {
    return `Host "${host.name}" is an ephemeral worker. Agents may use static workers only.`;
  }
  if (runnerMachines.latestLiveForWorker(targetHostId)) {
    return `Host "${host.name}" was started by a runner. Agents may use static workers only.`;
  }
  if (host.status !== "online") return `Host "${host.name}" is ${host.status}`;
  const allowed = allowedHostsOf(repo);
  if (!isHostAllowed(allowed, targetHostId)) {
    return onlyAvailableOnMessage(repo, hostNamesOf(allowed ?? []));
  }
  return null;
}
