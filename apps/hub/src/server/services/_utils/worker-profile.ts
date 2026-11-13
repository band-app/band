/**
 * The shape of a worker profile (`settings.workerProfiles[]`). A profile fixes how a worker is
 * provisioned and which vault items it receives. It names vault items and never
 * holds a secret. `services/worker-profile-service.ts` stores, checks and applies profiles.
 */

import { posix } from "node:path";
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

/** An environment variable name a secret may set. */
export const SECRET_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** Names the worker itself depends on, which a secret may not replace. */
const RESERVED_SECRET_ENV = new Set(["PATH", "HOME", "USER", "SHELL"]);

export function reservedSecretEnv(name: string): boolean {
  return RESERVED_SECRET_ENV.has(name) || name.startsWith("BAND_");
}

export const DEFAULT_SECRET_FILE_MODE = 0o600;
const MAX_SECRET_FILE_MODE = 0o700;

/** Parses a mode written as octal digits (`0600`), or null when it is not octal or allows more than 0700. */
export function parseSecretMode(text: string): number | null {
  if (!/^[0-7]{3,4}$/.test(text)) return null;
  const mode = Number.parseInt(text, 8);
  // At most 0700 as a permission set: no bit outside the owner's rwx.
  return (mode & ~MAX_SECRET_FILE_MODE) === 0 ? mode : null;
}

/**
 * A mapped file path in its `~/<relative>` form, or null when it is not under the home directory
 * after normalisation (`..`, absolute paths, the home itself).
 */
export function normalizeSecretFile(path: string): string | null {
  if (!path.startsWith("~/") || path.includes("\0")) return null;
  const rel = posix.normalize(path.slice(2));
  if (rel === "." || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return null;
  return `~/${rel.replace(/\/+$/, "")}`;
}

const secretMapping = z.union([
  z
    .object({
      item: itemName,
      env: z.string().superRefine((name, ctx) => {
        if (!SECRET_ENV_NAME.test(name)) {
          ctx.addIssue({
            code: "custom",
            message: "use letters A-Z, digits and '_', not starting with a digit",
          });
        } else if (reservedSecretEnv(name)) {
          ctx.addIssue({
            code: "custom",
            message: `${name} is set by Band or the system and cannot be mapped`,
          });
        }
      }),
    })
    .strict(),
  z
    .object({
      item: itemName,
      file: z
        .string()
        .max(500)
        .superRefine((path, ctx) => {
          if (normalizeSecretFile(path) === null) {
            ctx.addIssue({ code: "custom", message: "use a path under ~/ without '..'" });
          }
        }),
      mode: z
        .string()
        .refine((m) => parseSecretMode(m) !== null, "use octal digits, at most 0700")
        .optional(),
    })
    .strict(),
]);

export type SecretMapping = z.infer<typeof secretMapping>;

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
        /** Name of the vault item whose token clones the provisioning repo over HTTPS. */
        tokenItem: itemName.optional(),
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
    /** Vault items the worker receives, as environment variables or as files under its home. */
    secrets: z.array(secretMapping).max(100).optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const envs = new Set<string>();
    const files = new Set<string>();
    (profile.secrets ?? []).forEach((m, i) => {
      if ("env" in m) {
        if (envs.has(m.env)) {
          ctx.addIssue({
            code: "custom",
            path: ["secrets", i, "env"],
            message: `${m.env} is mapped twice`,
          });
        }
        envs.add(m.env);
      } else {
        const norm = normalizeSecretFile(m.file) ?? m.file;
        if (files.has(norm)) {
          ctx.addIssue({
            code: "custom",
            path: ["secrets", i, "file"],
            message: `${m.file} is mapped twice`,
          });
        }
        files.add(norm);
      }
    });
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
