/** The `worktree_create` call of a project coordinator, validated once before it runs. */

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

/** The shape the MCP tool registers. */
export const dispatchInputShape = {
  /** One repo of the project. Work in several repos takes one call per repo. */
  repo: z.string().min(1).max(200),
  branch: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  brief: z.string().min(1).max(50_000),
  scenarios: z.array(z.string().min(1).max(2_000)).max(30).default([]),
  placement: dispatchPlacement.optional(),
};

const dispatchInput = z.object(dispatchInputShape).strict();
export type DispatchInput = z.infer<typeof dispatchInput>;

/** Parses a call. Throws an Error whose message the agent sees. */
export function parseDispatchInput(raw: unknown): DispatchInput {
  const parsed = dispatchInput.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid worktree_create call: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}
