/** The proposal a retro agent hands back (plan step 6.5): the schema of its tool call and the stored item. */

import { z } from "zod";

export const RETRO_TARGETS = ["project-context", "user-context", "repo"] as const;
export type RetroTarget = (typeof RETRO_TARGETS)[number];

export const MAX_RETRO_ITEMS = 30;

export const retroItemShape = {
  target: z
    .enum(RETRO_TARGETS)
    .describe(
      "project-context: a file in this project's context repo. user-context: a file in the user's context repo (skills/, preferences.md). repo: a file in one of the project's repos (CLAUDE.md, a skill).",
    ),
  path: z
    .string()
    .min(1)
    .max(500)
    .describe("Path of the file, relative to the context or repo root."),
  repo: z.string().min(1).max(200).optional().describe("The repo name. Only for target repo."),
  content: z
    .string()
    .max(1_000_000)
    .nullable()
    .optional()
    .describe(
      "Context targets: the complete new content of the file, or null to delete it. A shorter notes.md goes here.",
    ),
  moveTo: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Context targets: archive a learnings/ file by moving it to learnings/archive/<name>. Use instead of content.",
    ),
  change: z
    .string()
    .min(1)
    .max(100_000)
    .optional()
    .describe(
      "Target repo: the change to make, as a unified diff or a precise description. A worker agent applies it in a pull request.",
    ),
  rationale: z.string().min(1).max(4_000).describe("Why this edit, in a few sentences."),
};

const item = z.object(retroItemShape).strict();

export const retroProposeShape = {
  summary: z.string().max(4_000).optional().describe("What the retro found, in a short paragraph."),
  items: z
    .array(item)
    .max(MAX_RETRO_ITEMS)
    .describe("The proposed edits. An empty list means nothing needs changing."),
};
export const retroProposeInput = z.object(retroProposeShape).strict();
export type RetroProposeInput = z.infer<typeof retroProposeInput>;
export type RetroItemInput = z.infer<typeof item>;

export type RetroItemStatus = "pending" | "accepted" | "rejected" | "failed";

export interface RetroItem extends RetroItemInput {
  /** `i1`, `i2`, ... in the order proposed. */
  id: string;
  /** What accepting changes, as a unified diff for a context file, or the agent's description for a repo. */
  diff: string;
  /** The head commit of the context when the item was proposed. A save is refused if the file changed since. */
  base: string | null;
  status: RetroItemStatus;
  error?: string;
  /** What accepting did: the context commit, or the dispatch it made. */
  result?: {
    commit?: string;
    dispatch?: "pending approval" | "dispatched";
    requestId?: string;
    worktreeIds?: string[];
  };
}

export type RetroStatus = "running" | "pending" | "reviewed" | "failed";
