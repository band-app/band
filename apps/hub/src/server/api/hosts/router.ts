/**
 * `hosts.list` — the machines Band can run worktrees on, for the Hosts screen
 * and `band hosts list`. The MCP endpoint leaves this procedure out.
 */

import type { Host } from "@band-app/host-api";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { hostRegistry } from "../../infra/host/registry";
import { ephemeralLifecycleService } from "../../services/ephemeral-lifecycle-service";
import {
  DEFAULT_LIST_LIMIT,
  HostRemoveError,
  MAX_LIST_LIMIT,
  tokenService,
} from "../../services/token-service";
import { emit } from "../../services/watcher-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

const AGENT_TYPES = ["claude-code", "codex", "opencode", "gemini-cli", "cursor-cli"];

/** The agent types a host can start. */
async function agentTypesOn(host: Host): Promise<string[]> {
  const found: string[] = [];
  for (const type of AGENT_TYPES) {
    try {
      if (typeof (await host.acp.resolveLaunch({ type })) !== "string") found.push(type);
    } catch {
      // A launch that throws is not available.
    }
  }
  return found;
}

export const hostsRouter = t.router({
  list: publicProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT) })
        .default({ limit: DEFAULT_LIST_LIMIT }),
    )
    .query(async ({ input }) => {
      const hosts = tokenService.listHosts(input.limit);
      // The local row has no hello, so describe this machine live.
      const local = hosts.find((h) => h.id === "local");
      if (local) {
        const info = await hostRegistry.local.info().catch(() => null);
        if (info) {
          local.home = info.home ?? null;
          local.capabilities = Object.entries(info.capabilities)
            .filter(([, on]) => on)
            .map(([name]) => name);
          local.agents = await agentTypesOn(hostRegistry.local);
          local.tools = info.tools;
        }
      }
      // An ephemeral worker the hub could not store before it exits stays up, and says why.
      return {
        hosts: hosts.map((h) => ({
          ...h,
          sleepError: ephemeralLifecycleService.lastError(h.id) ?? null,
        })),
      };
    }),

  /**
   * Removes a worker host: only when it is offline and has no worktrees.
   * Revokes its tokens, so the worker cannot dial in again.
   */
  remove: adminProcedure.input(z.object({ hostId: z.string().min(1) })).mutation(({ input }) => {
    try {
      const hostId = tokenService.removeHost(input.hostId);
      hostRegistry.unregister(hostId);
      emit({ kind: "host-status-changed", hostId, hostStatus: "disposed" });
      return { hostId };
    } catch (err) {
      if (err instanceof HostRemoveError) {
        throw new TRPCError({
          code: err.reason === "not-found" ? "NOT_FOUND" : "CONFLICT",
          message: err.message,
        });
      }
      throw err;
    }
  }),
});
