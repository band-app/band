/**
 * `hosts.list` — the machines Band can run worktrees on, for the Hosts screen
 * and `band hosts list`. The MCP endpoint leaves this procedure out.
 */

import type { Host } from "@band-app/host-api";
import { HOST_TRUST_LEVELS } from "@band-app/shared/host-trust";
import { hubUpdateCommand } from "@band-app/shared/versions";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { hostRegistry } from "../../infra/host/registry";
import { describeHostVersion } from "../../services/_utils/host-version";
import { HUB_VERSION, hubInstallMethod } from "../../services/_utils/hub-version";
import { agentLoginService } from "../../services/agent-login-service";
import { ephemeralLifecycleService } from "../../services/ephemeral-lifecycle-service";
import { hostTrustService } from "../../services/host-trust-service";
import { agentHostView } from "../../services/relay-scope";
import { releaseCheckService } from "../../services/release-check-service";
import { repoService } from "../../services/repo-service";
import {
  DEFAULT_LIST_LIMIT,
  HostRemoveError,
  MAX_LIST_LIMIT,
  tokenService,
} from "../../services/token-service";
import { emit } from "../../services/watcher-service";
import { WorkerUpdateError, workerUpdateService } from "../../services/worker-update-service";
import { repoErrorToTrpc } from "../repos/errors";
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

/** npm's output can name paths and registries, so only an admin sees it; others see that the update failed. */
function redactUpdateError<T extends { error: string | null } | null>(
  update: T,
  admin: boolean,
): T {
  return update && !admin && update.error ? { ...update, error: "The update failed." } : update;
}

export const hostsRouter = t.router({
  list: publicProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT) })
        .default({ limit: DEFAULT_LIST_LIMIT }),
    )
    .query(async ({ input, ctx }) => {
      const all = tokenService.listHosts(input.limit);
      // With `BAND_LOCAL_HOST=off` the hub's own machine takes no work, so the list leaves it out.
      // It stays a host inside the hub.
      const hosts = all.filter((h) => h.id !== "local" || h.usable);
      // The local row has no hello, so describe this machine live.
      const local = hosts.find((h) => h.id === "local");
      if (local) {
        const info = await hostRegistry.local.info().catch(() => null);
        if (info) {
          local.home = info.home ?? null;
          local.capabilities = Object.entries(info.capabilities)
            .filter(([, on]) => on)
            .map(([name]) => name);
          local.report = info.report ?? null;
          local.agents = info.report
            ? info.report.agents
                .filter(
                  (a) =>
                    a.installed &&
                    (a.loggedIn !== false || agentLoginService.hasUsableLogin(a.type)),
                )
                .map((a) => a.type)
            : await agentTypesOn(hostRegistry.local);
          local.tools = info.tools;
        }
      }
      // An ephemeral worker the hub could not store before it exits stays up, and says why.
      const latest = releaseCheckService.status().latest;
      return {
        hosts: hosts.map((h) => ({
          ...h,
          sleepError: ephemeralLifecycleService.lastError(h.id) ?? null,
          ...describeHostVersion(h, HUB_VERSION, latest),
          update: redactUpdateError(workerUpdateService.statusOf(h.id), ctx.admin),
        })),
      };
    }),

  /**
   * The host list as an agent may see it: id, name, status, OS and architecture, agents,
   * capabilities and labels. No roots, home, tool versions, tokens or runner settings. The MCP
   * endpoint lists this one and not `hosts.list`.
   */
  forAgents: publicProcedure.query(async () => {
    const hosts = tokenService
      .listHosts(MAX_LIST_LIMIT)
      .filter((h) => h.id !== "local" || h.usable);
    const local = hosts.find((h) => h.id === "local");
    const info = local ? await hostRegistry.local.info().catch(() => null) : null;
    return {
      hosts: hosts.map((h) => {
        const view = agentHostView({ ...h });
        if (h.id === "local" && info) {
          view.os = info.os;
          view.arch = info.arch;
          view.capabilities = Object.entries(info.capabilities)
            .filter(([, on]) => on)
            .map(([name]) => name);
          view.agents = info.report
            ? info.report.agents
                .filter(
                  (a) =>
                    a.installed &&
                    (a.loggedIn !== false || agentLoginService.hasUsableLogin(a.type)),
                )
                .map((a) => a.type)
            : view.agents;
        }
        return view;
      }),
    };
  }),

  /**
   * The hub's version, the newest release GitHub reported and the command that updates the hub for
   * how it was installed. Any device token may read it: the sidebar badge uses it.
   */
  updateStatus: publicProcedure.query(() => {
    const release = releaseCheckService.status();
    const method = hubInstallMethod();
    const target = release.latest ?? HUB_VERSION;
    return {
      hubVersion: HUB_VERSION,
      latest: release.latest,
      updateAvailable: release.updateAvailable,
      checkEnabled: release.enabled,
      checkedAt: release.checkedAt,
      installMethod: method,
      hubCommand: hubUpdateCommand(method, target),
    };
  }),

  /** The agents on a host that restarting its worker would end, for the confirm dialog. */
  interruptions: adminProcedure
    .input(z.object({ hostId: z.string().min(1) }))
    .query(({ input }) => ({ agents: workerUpdateService.interruptions(input.hostId) })),

  /**
   * Starts updating a worker to its target version and restarting it through its service manager.
   * Answers at once; the host row (`update`) shows installing, restarting and then the result. A
   * failed install keeps npm's message there and the worker running as it was. Restarting ends the agents on that host, so the UI asks first.
   */
  update: adminProcedure
    .input(z.object({ hostId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await workerUpdateService.update(input.hostId);
      } catch (err) {
        if (err instanceof WorkerUpdateError) {
          throw new TRPCError({
            code: err.reason === "not-found" ? "NOT_FOUND" : "CONFLICT",
            message: err.message,
          });
        }
        throw err;
      }
    }),

  /** Dismisses a failed update, so the Update button is offered again. */
  dismissUpdate: adminProcedure
    .input(z.object({ hostId: z.string().min(1) }))
    .mutation(({ input }) => {
      workerUpdateService.clear(input.hostId);
      return { hostId: input.hostId };
    }),

  /**
   * Lists the directories in a folder on a host, for the folder picker of "Add repo from a
   * worker". Without a path it starts at the host's home directory. It reaches outside the
   * host's roots, so only an admin token may call it, and picking a folder outside the roots
   * needs confirmation before it becomes a root (`repos.addFromWorker`).
   */
  browse: adminProcedure
    .input(z.object({ hostId: z.string().min(1), path: z.string().min(1).optional() }))
    .query(async ({ input }) => {
      try {
        return await repoService.browse(input.hostId, input.path);
      } catch (err) {
        throw repoErrorToTrpc(err);
      }
    }),

  /**
   * Sets how far a host's agents reach through the relay. Admin device tokens only: an agent's
   * relay call can never get here (`relay-scope.ts` refuses it whatever the host's level).
   */
  setTrust: adminProcedure
    .input(z.object({ hostId: z.string().min(1), trust: z.enum(HOST_TRUST_LEVELS) }))
    .mutation(({ input }) => {
      if (!hostTrustService.setTrust(input.hostId, input.trust)) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No host "${input.hostId}"` });
      }
      emit({ kind: "host-status-changed", hostId: input.hostId });
      return { hostId: input.hostId, trust: input.trust };
    }),

  /** What admin hosts did across hosts: time, calling host, chat, procedure and target. Newest first. */
  audit: adminProcedure
    .input(
      z.object({ limit: z.number().int().min(1).max(500).default(100) }).default({ limit: 100 }),
    )
    .query(({ input }) => ({ entries: hostTrustService.listAudit(input.limit) })),

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
