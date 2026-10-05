/**
 * The `runners` entry of `~/.band/settings.json` (plan step 3.4). A runner is a
 * pair of scripts the hub runs to get a machine: `spawn` starts a
 * `band-worker`, `destroy` cleans it up. `services/runner-service.ts` runs them.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { bandHome } from "../../infra/db/queries/settings";
import { RUNNER_ISOLATIONS } from "./isolation";

export const DEFAULT_RUNNER_TIMEOUT_SEC = 120;
export const MAX_RUNNER_TIMEOUT_SEC = 3600;
export const DEFAULT_SNAPSHOT_KEEP = 3;
export const DEFAULT_SNAPSHOT_TTL_SEC = 7 * 24 * 3600;
export const DEFAULT_SNAPSHOT_TIMEOUT_SEC = 600;
/** The worker waits 15 minutes for the hub's answer to `lifecycle.idle`, and the snapshot is taken inside it. */
export const MAX_SNAPSHOT_TIMEOUT_SEC = 780;

/** The hook scripts a runner can have. The bundled name is `<runner dir>/<name>.sh`. */
export type HookScript =
  | "spawn"
  | "destroy"
  | "status"
  | "snapshot"
  | "restore"
  | "snapshot-delete";
/** Seconds after `maxLifetimeSec` before the reaper destroys a machine that could not be put to sleep. */
export const DEFAULT_LIFETIME_GRACE_SEC = 600;
const MAX_LIFETIME_SEC = 60 * 60 * 24 * 90;

/** Prefix that names a hook shipped in the repo's `runners/` directory, like `bundled:local`. */
export const BUNDLED_PREFIX = "bundled:";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name");

const hookPath = z.string().trim().min(1).max(1000);

export const runnerSchema = z
  .object({
    id: z.string().regex(ID, "ids are letters, digits, '.', '_' and '-', up to 64 characters"),
    kind: z.literal("hook").default("hook"),
    /** A script path (absolute, or relative to BAND_HOME), or `bundled:<name>` for the hooks in `runners/`. */
    spawn: hookPath,
    destroy: hookPath.optional(),
    /**
     * Optional. Prints the handle of every live machine of this runner, one per line, so the reaper
     * can destroy machines the hub has no record of.
     */
    status: hookPath.optional(),
    /** What this runner offers. A request is leasable when every label it asks for is here. */
    labels: z.record(z.string(), z.string()).default({}),
    /**
     * Facts about the machines this runner starts (`{ os: "linux", node: "24" }`), checked against a
     * request's `requires`. Without it the runner takes requests whatever they require.
     */
    provides: z.record(z.string(), z.string()).optional(),
    /**
     * The isolation the machines it starts have. A request asking for `container` or `vm`
     * (`placement.environment.isolation`) goes only to a runner offering at least that.
     * `process` is the same as `worktree`. Passed to the hook as `BAND_ISOLATION`.
     */
    isolation: z.enum(RUNNER_ISOLATIONS).default("process"),
    maxConcurrent: z.number().int().min(1).max(100).default(1),
    /** Seconds from the start of an attempt to the worker's hello. */
    timeoutSec: z
      .number()
      .int()
      .min(1)
      .max(MAX_RUNNER_TIMEOUT_SEC)
      .default(DEFAULT_RUNNER_TIMEOUT_SEC),
    /**
     * How long a machine may live, counted from its spawn. Past it the reaper has the worker store
     * its worktrees and exit, then runs `destroy`. Without it a machine lives until it exits.
     */
    maxLifetimeSec: z.number().int().min(1).max(MAX_LIFETIME_SEC).optional(),
    /**
     * Seconds after `maxLifetimeSec` the reaper waits for the worktrees to be stored. Past that
     * deadline it destroys the machine whether or not they were, and logs it as an error.
     */
    lifetimeGraceSec: z
      .number()
      .int()
      .min(0)
      .max(MAX_LIFETIME_SEC)
      .default(DEFAULT_LIFETIME_GRACE_SEC),
    /** Extra environment for the hook (`BAND_SSH_TARGET`, `BAND_WORKER_BIN`). Not secret: the settings file shows it. */
    env: z.record(envName, z.string()).default({}),
    /**
     * Hibernate hooks (plan step 3.10). With `snapshot` and `restore`, putting an ephemeral worker's
     * worktrees to sleep also snapshots the machine's disk, and waking restores from it. `snapshot`
     * gets `BAND_MACHINE_HANDLE` and prints `BAND_SNAPSHOT_ID=<id>`, `restore` gets `BAND_SNAPSHOT_ID` and
     * the spawn environment, `snapshotDelete` gets `BAND_SNAPSHOT_ID` and removes it.
     */
    snapshot: hookPath.optional(),
    restore: hookPath.optional(),
    snapshotDelete: hookPath.optional(),
    /** Snapshots of this runner to keep, newest first. Older ones go through `snapshotDelete`. */
    snapshotKeep: z.number().int().min(1).max(1000).default(DEFAULT_SNAPSHOT_KEEP),
    /** Seconds a snapshot lives before `snapshotDelete` removes it. */
    snapshotTtlSec: z
      .number()
      .int()
      .min(60)
      .max(90 * 24 * 3600)
      .default(DEFAULT_SNAPSHOT_TTL_SEC),
    /** Seconds the `snapshot` hook may run. The worker waits at most 15 minutes for the sleep to finish. */
    snapshotTimeoutSec: z
      .number()
      .int()
      .min(1)
      .max(MAX_SNAPSHOT_TIMEOUT_SEC)
      .default(DEFAULT_SNAPSHOT_TIMEOUT_SEC),
  })
  .refine((r) => (r.snapshot === undefined) === (r.restore === undefined), {
    message: "snapshot and restore go together: set both or neither",
    path: ["snapshot"],
  });

export type RunnerConfig = z.infer<typeof runnerSchema>;

/** Validates the whole list: ids must be unique. */
export const runnersSchema = z.array(runnerSchema).superRefine((runners, ctx) => {
  const seen = new Set<string>();
  runners.forEach((r, i) => {
    if (seen.has(r.id)) {
      ctx.addIssue({ code: "custom", path: [i, "id"], message: `duplicate runner id "${r.id}"` });
    }
    seen.add(r.id);
  });
});

/** The runners in a settings document. A bad entry is skipped, not fatal, so one typo doesn't stop the others. */
export function parseRunners(raw: unknown): { runners: RunnerConfig[]; errors: string[] } {
  if (raw === undefined || raw === null) return { runners: [], errors: [] };
  if (!Array.isArray(raw)) return { runners: [], errors: ["runners must be a list"] };
  const runners: RunnerConfig[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const parsed = runnerSchema.safeParse(entry);
    if (!parsed.success) {
      errors.push(`runners[${i}]: ${parsed.error.issues.map((x) => x.message).join("; ")}`);
    } else if (seen.has(parsed.data.id)) {
      errors.push(`runners[${i}]: duplicate runner id "${parsed.data.id}"`);
    } else {
      seen.add(parsed.data.id);
      runners.push(parsed.data);
    }
  });
  return { runners, errors };
}

/**
 * The directory with the bundled hooks: `BAND_RUNNERS_DIR`, else the nearest
 * `runners/` above this file (the repository, or beside the built bundle).
 */
export function bundledRunnersDir(): string {
  const fromEnv = process.env.BAND_RUNNERS_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "runners");
    if (existsSync(join(candidate, "local", "spawn.sh"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(import.meta.dirname, "runners");
}

/** The absolute path of a hook script, or an error message when it cannot be one. */
export function resolveHookPath(spec: string, script: HookScript): string {
  if (spec.startsWith(BUNDLED_PREFIX)) {
    const name = spec.slice(BUNDLED_PREFIX.length);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid bundled hook "${spec}"`);
    return join(bundledRunnersDir(), name, `${script}.sh`);
  }
  return isAbsolute(spec) ? spec : resolve(bandHome(), spec);
}
