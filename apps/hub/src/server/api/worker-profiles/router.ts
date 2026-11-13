/**
 * `workerProfiles.*`: named worker profiles and their assignment to workers. Admin tokens only.
 * The MCP endpoint and the worker relay leave this router out, because a profile decides what a
 * worker may receive from the vault and no worker may choose its own.
 */

import { z } from "zod";
import { emit } from "../../services/watcher-service";
import { workerProfileService } from "../../services/worker-profile-service";
import { workerSecretsService } from "../../services/worker-secrets-service";
import { adminProcedure, t } from "../trpc";

export const workerProfilesRouter = t.router({
  /** Every valid profile with the number of workers using it, and the entries that were refused. */
  list: adminProcedure.query(() => workerProfileService.list()),

  create: adminProcedure
    .input(z.unknown())
    .mutation(({ input }) => workerProfileService.create(input)),

  update: adminProcedure
    .input(z.object({ name: z.string().min(1).max(100), profile: z.unknown() }))
    .mutation(({ input }) => {
      const profile = workerProfileService.update(input.name, input.profile);
      workerSecretsService.profileChanged(input.name);
      return profile;
    }),

  delete: adminProcedure
    .input(z.object({ name: z.string().min(1).max(100) }))
    .mutation(({ input }) => {
      workerProfileService.remove(input.name);
      return { name: input.name };
    }),

  /** Attaches a profile to a worker, or removes it with `null`. Attaching applies the profile's trust. */
  setWorkerProfile: adminProcedure
    .input(z.object({ hostId: z.string().min(1), profile: z.string().min(1).max(100).nullable() }))
    .mutation(({ input }) => {
      const result = workerProfileService.setHostProfile(input.hostId, input.profile);
      workerSecretsService.profileChanged(null, input.hostId);
      emit({ kind: "host-status-changed", hostId: input.hostId });
      return result;
    }),
});

export type WorkerProfilesRouter = typeof workerProfilesRouter;
