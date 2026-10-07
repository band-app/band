/**
 * A project's policy (plan step 6.2): the limits and the autonomy level of its
 * coordinator. The stored value holds only what the user set. `resolvePolicy`
 * fills in the defaults, and every check reads the resolved form.
 */

import { Cron } from "croner";
import { z } from "zod";

/** The name the coordinator's tools go by in a session's `mcpServers`. The proxy route serves it itself, so no MCP server may take the name. */
export const COORDINATOR_SERVER = "band-coordinator";
/** The hub's own tools for a project's retro agent (plan step 6.5), served on the same proxy route. */
export const RETRO_SERVER = "band-retro";
/** The hub's own tools for the agent of a task (plan step T.2): add and remove the task's repos. */
export const TASK_SERVER = "band-task";
/** The chat label that marks a project's retro chat. Its value is the project id. */
export const RETRO_LABEL = "band:retro";
/** The chat label that marks a project's coordinator chat. */
export const COORDINATOR_LABEL = "band:coordinator";

export const AUTONOMY_LEVELS = ["observe", "steer", "autonomous"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export const ISOLATION_LEVELS = ["worktree", "container", "vm"] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

export const DEFAULT_AUTONOMY: Autonomy = "steer";
export const DEFAULT_MODELS = {
  coordinator: "opus",
  worker: "sonnet",
  reviewer: "sonnet",
} as const;

/** A weekly retro, Monday 09:00 server time, once the user turns it on. */
export const DEFAULT_RETRO_CRON = "0 9 * * 1";

function validCron(expression: string): boolean {
  // croner also takes an ISO date as a one-off schedule, which a recurring retro must not.
  const fields = expression.trim().split(/\s+/).length;
  if (fields < 5 || fields > 6) return false;
  try {
    const cron = new Cron(expression, { maxRuns: 0 });
    const [a, b] = cron.nextRuns(2);
    // Each run starts an agent turn, so an expression that fires more often than hourly is refused.
    return !a || !b || b.getTime() - a.getTime() >= 3_600_000;
  } catch {
    return false;
  }
}

const model = z.string().trim().min(1).max(100);

export const projectPolicy = z.preprocess(
  (value) => {
    // 6.1 stored the isolation level as `isolation`.
    if (value && typeof value === "object" && "isolation" in value) {
      const { isolation, ...rest } = value as Record<string, unknown>;
      return "isolationFloor" in rest ? rest : { ...rest, isolationFloor: isolation };
    }
    return value;
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
      /** The scheduled retro (plan step 6.5). Off until `enabled` is true. */
      retro: z
        .object({
          enabled: z.boolean().optional(),
          cron: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .refine(validCron, "Invalid cron expression")
            .optional(),
        })
        .strict()
        .optional(),
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
  retro: { enabled: boolean; cron: string };
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
    retro: { enabled: p.retro?.enabled === true, cron: p.retro?.cron ?? DEFAULT_RETRO_CRON },
    models: {
      coordinator: p.models?.coordinator ?? coordinatorModel ?? DEFAULT_MODELS.coordinator,
      worker: p.models?.worker ?? DEFAULT_MODELS.worker,
      reviewer: p.models?.reviewer ?? DEFAULT_MODELS.reviewer,
    },
  };
}
