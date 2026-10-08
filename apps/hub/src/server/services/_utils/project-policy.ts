/**
 * A project's policy (plan step 6.2): the limits and the autonomy level of its
 * coordinator. The stored value holds only what the user set. `resolvePolicy`
 * fills in the defaults, and every check reads the resolved form.
 */

import { z } from "zod";

/** The name the coordinator's tools go by in a session's `mcpServers`. The proxy route serves it itself, so no MCP server may take the name. */
export const COORDINATOR_SERVER = "band-coordinator";
/** The chat label that marks a project's coordinator chat. */
export const COORDINATOR_LABEL = "band:coordinator";

export const AUTONOMY_LEVELS = ["observe", "autonomous"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export const ISOLATION_LEVELS = ["worktree", "container", "vm"] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

export const DEFAULT_AUTONOMY: Autonomy = "autonomous";
export const DEFAULT_MODELS = {
  coordinator: "opus",
  worker: "sonnet",
  reviewer: "sonnet",
} as const;

const model = z.string().trim().min(1).max(100);

export const projectPolicy = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object") return value;
    let policy = value as Record<string, unknown>;
    // 6.1 stored the isolation level as `isolation`.
    if ("isolation" in policy) {
      const { isolation, ...rest } = policy;
      policy = "isolationFloor" in rest ? rest : { ...rest, isolationFloor: isolation };
    }
    // The `steer` level, which held dispatches for approval, is gone: a dispatch now runs at once.
    // Auto-merge was off under steer, so it stays off until the user turns it on again.
    if (policy.autonomy === "steer")
      policy = { ...policy, autonomy: "autonomous", autoMerge: false };
    // The scheduled retro is gone: a user who wants one makes a cronjob.
    if ("retro" in policy) {
      const { retro: _retro, ...rest } = policy;
      policy = rest;
    }
    return policy;
  },
  z
    .object({
      /** `k=v` host labels the project's worker agents may be placed on. */
      labels: z.array(z.string().min(1).max(100)).max(20).optional(),
      /** Soft limit in USD. A new dispatch is refused once the project has spent it. */
      budgetUsd: z.number().positive().max(1_000_000).optional(),
      /** Worker agents running a turn at once. */
      maxConcurrent: z.number().int().min(1).max(100).optional(),
      /** The weakest isolation a worker agent may run at. */
      isolationFloor: z.enum(ISOLATION_LEVELS).optional(),
      autonomy: z.enum(AUTONOMY_LEVELS).optional(),
      /** With `autonomy: autonomous`, the coordinator may merge without asking. */
      autoMerge: z.boolean().optional(),
      models: z
        .object({
          coordinator: model.optional(),
          worker: model.optional(),
          reviewer: model.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
);
export type ProjectPolicy = z.infer<typeof projectPolicy>;

export interface ResolvedPolicy {
  labels: string[];
  budgetUsd: number | null;
  maxConcurrent: number | null;
  isolationFloor: IsolationLevel;
  autonomy: Autonomy;
  autoMerge: boolean;
  models: { coordinator: string; worker: string; reviewer: string };
}

export function resolvePolicy(
  policy: ProjectPolicy | Record<string, unknown> | undefined,
  coordinatorModel?: string,
): ResolvedPolicy {
  const parsed = projectPolicy.safeParse(policy ?? {});
  const p: ProjectPolicy = parsed.success ? parsed.data : {};
  return {
    labels: p.labels ?? [],
    budgetUsd: p.budgetUsd ?? null,
    maxConcurrent: p.maxConcurrent ?? null,
    isolationFloor: p.isolationFloor ?? "worktree",
    // A stored policy that no longer parses must not grant message and stop rights.
    autonomy: p.autonomy ?? (parsed.success ? DEFAULT_AUTONOMY : "observe"),
    // Merging without asking needs both the autonomous level and the explicit opt-in.
    autoMerge: p.autonomy === "autonomous" && p.autoMerge === true,
    models: {
      coordinator: p.models?.coordinator ?? coordinatorModel ?? DEFAULT_MODELS.coordinator,
      worker: p.models?.worker ?? DEFAULT_MODELS.worker,
      reviewer: p.models?.reviewer ?? DEFAULT_MODELS.reviewer,
    },
  };
}
