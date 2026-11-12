/**
 * The shape of a worker profile (`settings.workerProfiles[]`). A profile fixes how a worker is
 * provisioned and which vault credentials it may receive. It names vault items and logins and never
 * holds a secret. `services/worker-profile-service.ts` stores, checks and applies profiles.
 */

import { HOST_TRUST_LEVELS } from "@band-app/shared/host-trust";
import { z } from "zod";

export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** The worker reads only these names from its service environment. */
export const PROFILE_ENV_NAME = /^BAND_WORKER_[A-Z0-9_]+$/;
/** Set by the hub from the exchange, so a profile cannot carry its own. */
export const RESERVED_PROFILE_ENV = new Set(["BAND_WORKER_TOKEN", "BAND_WORKER_ID"]);

/** The script reads the profile's env from `key=value` lines, so the value stays in this set. */
const SAFE_ENV_VALUE = /^[A-Za-z0-9 _.,:=@/+-]*$/;

const itemName = z.string().trim().min(1).max(200);

export const workerProfileSchema = z
  .object({
    name: z
      .string()
      .regex(PROFILE_NAME, "use letters, digits, '.', '_' and '-', up to 64 characters"),
    provisioning: z
      .object({
        repoUrl: z.string().max(500).optional(),
        branch: z.string().max(200).optional(),
        command: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    labels: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+$/, "use key=value"))
      .max(20)
      .optional(),
    trust: z.enum(HOST_TRUST_LEVELS).optional(),
    env: z
      .record(
        z.string().regex(PROFILE_ENV_NAME, "only BAND_WORKER_* names are allowed"),
        z
          .string()
          .max(500)
          .regex(SAFE_ENV_VALUE, "use letters, digits, spaces and _ . , : = @ / + -"),
      )
      .optional(),
    ownChats: z.boolean().optional(),
    credentials: z
      .object({
        /** Names of the vault git items the worker may receive. */
        git: z.array(itemName).max(100).optional(),
        /** The name of the one git item whose token `gh` gets. */
        gh: itemName.optional(),
        /** Ids or labels of the agent logins agents on the worker may use. */
        agentLogins: z.array(itemName).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    for (const name of Object.keys(profile.env ?? {})) {
      if (RESERVED_PROFILE_ENV.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["env", name],
          message: "the hub sets this variable",
        });
      }
    }
  });

export type WorkerProfile = z.infer<typeof workerProfileSchema>;

/** `path: message` for the first problem, so an error names the field. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
