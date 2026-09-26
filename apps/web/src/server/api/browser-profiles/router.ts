/**
 * `browserProfiles.*` — Band browser profiles and each project's default
 * profile. Thin: validates input and delegates to `BrowserProfileService`.
 *
 * Profiles carry metadata only. Importing Chrome cookies happens entirely in
 * the desktop app (`apps/desktop/src/browser/chrome-import/`); the cookies
 * never pass through this server.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { BrowserProfileNotFoundError } from "../../errors";
import {
  BROWSER_PROFILE_ID_PATTERN,
  browserProfileService,
} from "../../services/browser-profile-service";
import { publicProcedure, t } from "../trpc";

const profileId = z.string().regex(BROWSER_PROFILE_ID_PATTERN);
const profileName = z.string().trim().min(1).max(100);

/** Map the service's not-found error to a 404; rethrow anything else. */
export function rethrowProfileNotFound(err: unknown): never {
  if (err instanceof BrowserProfileNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  throw err;
}

export const browserProfilesRouter = t.router({
  list: publicProcedure.query(() => {
    return { profiles: browserProfileService.list() };
  }),

  create: publicProcedure
    .input(
      z.object({
        // The desktop generates the id so it can import cookies into the
        // matching partition before the row exists.
        id: profileId.optional(),
        name: profileName,
        source: z.enum(["chrome"]).nullish(),
      }),
    )
    .mutation(({ input }) => {
      if (input.id && browserProfileService.get(input.id)) {
        throw new TRPCError({ code: "CONFLICT", message: "Browser profile already exists" });
      }
      return { profile: browserProfileService.create(input) };
    }),

  rename: publicProcedure
    .input(z.object({ profileId, name: profileName }))
    .mutation(({ input }) => {
      try {
        return { profile: browserProfileService.rename(input.profileId, input.name) };
      } catch (err) {
        rethrowProfileNotFound(err);
      }
    }),

  remove: publicProcedure.input(z.object({ profileId })).mutation(({ input }) => {
    try {
      browserProfileService.remove(input.profileId);
    } catch (err) {
      rethrowProfileNotFound(err);
    }
    return { ok: true };
  }),

  /** Every project's default profile. Projects with no row use Default. */
  projectDefaults: publicProcedure.query(() => {
    return { defaults: browserProfileService.listProjectDefaults() };
  }),

  getProjectDefault: publicProcedure
    .input(z.object({ projectName: z.string() }))
    .query(({ input }) => {
      return { profileId: browserProfileService.getProjectDefault(input.projectName) };
    }),

  /** `profileId: null` resets the project to the Default profile. */
  setProjectDefault: publicProcedure
    .input(z.object({ projectName: z.string(), profileId: profileId.nullable() }))
    .mutation(({ input }) => {
      try {
        browserProfileService.setProjectDefault(input.projectName, input.profileId);
      } catch (err) {
        rethrowProfileNotFound(err);
      }
      return { ok: true };
    }),
});

export type BrowserProfilesRouter = typeof browserProfilesRouter;
