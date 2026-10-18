/**
 * `provisioning.*`: one-line provisioning of new hosts. Admin
 * tokens only. The MCP endpoint and the worker relay leave this router out, because a command
 * it creates runs on a machine the caller does not hold.
 */

import { z } from "zod";
import { provisioningService } from "../../services/provisioning-service";
import { adminProcedure, t } from "../trpc";

const settingsInput = z.object({
  repoUrl: z.string().max(500).optional(),
  branch: z.string().max(200).optional(),
  command: z.string().max(200).optional(),
});

export const provisioningRouter = t.router({
  /** Makes a one-time command. `hubUrl` is the address the new machine reaches the hub at. */
  createCommand: adminProcedure
    .input(
      z.object({
        hubUrl: z.string().min(1).max(500),
        hostName: z.string().max(100).optional(),
        labels: z
          .array(z.string().regex(/^[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+$/))
          .max(20)
          .optional(),
      }),
    )
    .mutation(({ input }) => provisioningService.create(input)),

  /** One command's state and log, or the newest commands when no id is given. */
  status: adminProcedure
    .input(z.object({ id: z.string().min(1).max(100).optional() }).optional())
    .query(({ input }) =>
      input?.id
        ? { commands: [provisioningService.status(input.id)].filter((c) => c !== null) }
        : { commands: provisioningService.list() },
    ),

  settings: adminProcedure.query(() => provisioningService.settings()),

  updateSettings: adminProcedure
    .input(settingsInput)
    .mutation(({ input }) => provisioningService.updateSettings(input)),
});

export type ProvisioningRouter = typeof provisioningRouter;
