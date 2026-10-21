/**
 * Per-worker agent command overrides: the write path for `workers.setAgentCommand` and the
 * state `workers.list` shows (what each agent runs on a worker, and whether an overridden
 * command exists on the worker's PATH). The launch paths read the override through
 * `_utils/agent-command.ts`.
 */

import { TokenQueries } from "../infra/db/queries/tokens";
import { checkAgentCommand } from "./_utils/agent-command";
import { modelRefreshService } from "./model-refresh-service";
import { settingsService } from "./settings-service";
import { emit } from "./watcher-service";

/** Why `setAgentCommand` refused. The router maps `code` to an HTTP-style error. */
export class AgentCommandError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export interface AgentCommandState {
  agentId: string;
  type: string;
  label: string;
  override: string | null;
  effective: string | null;
  /** Null when the command is not an override, the worker is offline, or the check failed. */
  found: boolean | null;
}

/** How long a PATH check on a worker is reused, so repeated `workers.list` calls cost no RPC. */
const FOUND_TTL_MS = 30_000;
/** A worker that does not answer in this time counts as unknown, not as missing the command. */
const PROBE_TIMEOUT_MS = 3_000;
/** The message `resolveAcpLaunch` gives for a command that is on no PATH directory. */
const NOT_FOUND = /was not found or is not executable/;

export class HostAgentCommandService {
  private readonly queries = new TokenQueries();
  private readonly cache = new Map<string, { at: number; found: boolean | null }>();

  /** Sets or clears (`null`) the command an agent runs as on one worker. */
  setAgentCommand(hostId: string, agentId: string, command: string | null): string | null {
    const known = (settingsService.get().codingAgents ?? []).some((a) => a.id === agentId);
    if (!known) throw new AgentCommandError("NOT_FOUND", `No coding agent "${agentId}"`);
    let checked: string | null = null;
    if (command !== null) {
      try {
        checked = checkAgentCommand(command);
      } catch (err) {
        throw new AgentCommandError(
          "BAD_REQUEST",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const row = this.queries.findHost(hostId);
    if (!row) throw new AgentCommandError("NOT_FOUND", `No worker "${hostId}"`);
    const next = { ...(row.agentCommands ?? {}) };
    if (checked === null) delete next[agentId];
    else next[agentId] = checked;
    this.queries.setHostAgentCommands(hostId, next);
    for (const key of this.cache.keys()) if (key.startsWith(`${hostId}\0`)) this.cache.delete(key);
    emit({ kind: "host-status-changed", hostId });
    return checked;
  }

  /**
   * What each configured agent runs on a host. `probe` makes the worker look up an overridden
   * command; callers pass false when the reader may not trigger worker calls.
   */
  async states(
    host: { id: string; status: string; agentCommands: Record<string, string> },
    probe: boolean,
  ): Promise<AgentCommandState[]> {
    return Promise.all(
      (settingsService.get().codingAgents ?? []).map(async (def) => {
        const override = host.agentCommands[def.id] ?? null;
        const effective = override ?? def.command ?? null;
        const found =
          override && probe && host.status === "online"
            ? await this.found(host.id, def.id, override)
            : null;
        return { agentId: def.id, type: def.type, label: def.label, override, effective, found };
      }),
    );
  }

  private async found(hostId: string, agentId: string, command: string): Promise<boolean | null> {
    const key = `${hostId}\0${agentId}\0${command}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < FOUND_TTL_MS) return hit.found;
    let timer: NodeJS.Timeout | undefined;
    const problem = await Promise.race([
      modelRefreshService.launchProblemOn(hostId, agentId),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS);
      }),
    ])
      .catch(() => "timeout" as const)
      .finally(() => clearTimeout(timer));
    // Only the not-found message means the binary is missing. Another problem or a timeout is unknown.
    const found =
      problem === null ? true : problem !== "timeout" && NOT_FOUND.test(problem) ? false : null;
    this.cache.set(key, { at: Date.now(), found });
    return found;
  }
}

export const hostAgentCommandService = new HostAgentCommandService();
