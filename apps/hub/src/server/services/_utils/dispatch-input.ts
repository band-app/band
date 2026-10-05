/** The `worktrees_create` call of a project coordinator (plan step 6.3), validated once and stored as-is for an approval. */

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

export const dispatchGroup = z
  .object({
    repos: z
      .array(z.object({ repo: z.string().min(1).max(200), role: z.string().max(100).optional() }))
      .min(2)
      .max(10),
    mode: z.enum(["split", "combined"]),
    /** The repos in the order their pull requests merge. Defaults to the order of `repos`. */
    mergeOrder: z.array(z.string().min(1).max(200)).max(10).optional(),
  })
  .strict();

/** The shape the MCP tool registers. Cross-field rules run in `parseDispatchInput`. */
export const dispatchInputShape = {
  repo: z.string().min(1).max(200).optional(),
  group: dispatchGroup.optional(),
  branch: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  brief: z.string().min(1).max(50_000),
  scenarios: z.array(z.string().min(1).max(2_000)).max(30).default([]),
  placement: dispatchPlacement.optional(),
};

const dispatchInput = z.object(dispatchInputShape).strict();
export type DispatchInput = z.infer<typeof dispatchInput>;

/** Parses a call and checks the rules that span fields. Throws an Error whose message the agent sees. */
export function parseDispatchInput(raw: unknown): DispatchInput {
  const parsed = dispatchInput.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid worktrees_create call: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const input = parsed.data;
  if (!input.repo === !input.group) {
    throw new Error("Pass exactly one of repo or group.");
  }
  if (input.group) {
    const repos = input.group.repos.map((r) => r.repo);
    if (new Set(repos).size !== repos.length) {
      throw new Error("A repo appears twice in group.repos.");
    }
    const order = input.group.mergeOrder;
    if (
      order &&
      (order.length !== repos.length ||
        new Set(order).size !== order.length ||
        !order.every((r) => repos.includes(r)))
    ) {
      throw new Error("group.mergeOrder must list every repo of the group exactly once.");
    }
  }
  return input;
}
