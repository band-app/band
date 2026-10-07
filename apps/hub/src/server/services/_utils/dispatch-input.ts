/** The `tasks_create` call of a project coordinator (plan steps 6.3 and T.2), validated once and stored as-is for an approval. */

import { z } from "zod";
import { ISOLATION_LEVELS } from "./project-policy";

const labelMap = z
  .record(z.string().min(1).max(100), z.string().max(200))
  .refine((m) => Object.keys(m).length <= 20, "at most 20 labels");

export const dispatchPlacement = z
  .object({
    /** Host labels, `{ zone: "home" }` for `zone=home`. Must be among the project's labels when it has any. */
    labels: labelMap.optional(),
    /** Tool versions or facts the host must have: `{ node: ">=24" }`. */
    requires: labelMap.optional(),
    /** At or above the project's floor. Defaults to the floor. */
    isolation: z.enum(ISOLATION_LEVELS).optional(),
  })
  .strict();

export const taskRepo = z
  .object({
    repo: z.string().min(1).max(200),
    role: z.string().max(100).optional(),
    /** Host labels this repo needs. The task's host must carry the labels of every repo. */
    labels: labelMap.optional(),
  })
  .strict();

/** The shape the MCP tool registers. Cross-field rules run in `parseDispatchInput`. */
export const dispatchInputShape = {
  /** The task folder's name. Defaults to the branch with "/" replaced by "-". */
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, "lowercase letters, digits, '.', '_' and '-'")
    .optional(),
  branch: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  brief: z.string().min(1).max(50_000),
  /** The repos to start with, from the project's repos. None starts an empty task whose agent adds repos itself. */
  repos: z.array(taskRepo).max(10).default([]),
  scenarios: z.array(z.string().min(1).max(2_000)).max(30).default([]),
  /** The host id to create the task on. Without one the hub picks a host that fits. */
  host: z.string().min(1).max(200).optional(),
  placement: dispatchPlacement.optional(),
};

const dispatchInput = z.object(dispatchInputShape).strict();
export type DispatchInput = z.infer<typeof dispatchInput>;

/**
 * A request stored before tasks held `repo` (one repo) or `group` ({ repos, mode, mergeOrder })
 * instead of `repos`. Rewrites it to the current shape and leaves a current one alone.
 */
export function normalizeStoredDispatchInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const { repo, group, ...rest } = raw as Record<string, unknown>;
  if ("repos" in rest) return rest;
  if (typeof repo === "string") return { ...rest, repos: [{ repo }] };
  const groupRepos = (group as { repos?: unknown } | undefined)?.repos;
  if (Array.isArray(groupRepos)) return { ...rest, repos: groupRepos };
  return rest;
}

/** Parses a call and checks the rules that span fields. Throws an Error whose message the agent sees. */
export function parseDispatchInput(raw: unknown): DispatchInput {
  const parsed = dispatchInput.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid tasks_create call: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const input = parsed.data;
  const repos = input.repos.map((r) => r.repo);
  if (new Set(repos).size !== repos.length) {
    throw new Error("A repo appears twice in repos.");
  }
  return input;
}
