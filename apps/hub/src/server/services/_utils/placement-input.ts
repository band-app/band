import { z } from "zod";

/** Bounded, because every unplaced `worktrees.create` stores its placement in a row. */
const shortMap = z
  .record(z.string().min(1).max(100), z.string().max(200))
  .refine((m) => Object.keys(m).length <= 50, "at most 50 entries");

export const placementInput = z.object({
  /** Labels the host must carry, `{ zone: "home" }` for the host label `zone=home`. */
  labels: shortMap.optional(),
  /** Tool versions or facts the host must have: `{ node: ">=24", os: "linux" }`. */
  requires: shortMap.optional(),
  /** Passed to the runner that starts the machine (`BAND_ENVIRONMENT`). */
  environment: z
    .record(z.string().min(1).max(100), z.unknown())
    .refine((m) => Object.keys(m).length <= 50, "at most 50 entries")
    .optional(),
});
export type Placement = z.infer<typeof placementInput>;
