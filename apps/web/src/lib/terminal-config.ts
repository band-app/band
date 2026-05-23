import { createLogger } from "@band-app/logger";
import { z } from "zod";
import type { WorkspaceTerminalConfig } from "@/dashboard";
import { loadProjectConfig } from "./project-config";

const log = createLogger("terminal-config");

// ---------------------------------------------------------------------------
// Zod schemas for workspace.terminal configuration
// ---------------------------------------------------------------------------

const TerminalPaneConfigSchema = z.object({
  name: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  focus: z.boolean().optional(),
});

const PaneNodeSchema = z.object({
  pane: TerminalPaneConfigSchema,
});

type TerminalLayoutNodeInput =
  | { pane: z.infer<typeof TerminalPaneConfigSchema> }
  | {
      direction: "horizontal" | "vertical";
      split?: number;
      children: [TerminalLayoutNodeInput, TerminalLayoutNodeInput];
    };

const TerminalLayoutNodeSchema: z.ZodType<TerminalLayoutNodeInput> = z.lazy(() =>
  z.union([
    PaneNodeSchema,
    z.object({
      direction: z.enum(["horizontal", "vertical"]),
      split: z.number().min(0.1).max(0.9).optional().default(0.5),
      children: z.tuple([TerminalLayoutNodeSchema, TerminalLayoutNodeSchema]),
    }),
  ]),
);

const WorkspaceTerminalConfigSchema = z.object({
  layout: TerminalLayoutNodeSchema,
});

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load and validate the workspace terminal configuration from
 * `.band/config.json`. Returns `null` when the config file doesn't exist,
 * doesn't contain a `workspace.terminal` block, or fails validation.
 */
export function loadWorkspaceTerminalConfig(
  worktreePath: string,
  projectPath: string,
): WorkspaceTerminalConfig | null {
  const raw = loadProjectConfig(worktreePath, projectPath);
  if (!raw) return null;

  const terminalBlock =
    raw.workspace && typeof raw.workspace === "object"
      ? (raw.workspace as Record<string, unknown>).terminal
      : undefined;

  if (!terminalBlock) return null;

  const result = WorkspaceTerminalConfigSchema.safeParse(terminalBlock);
  if (!result.success) {
    log.warn(
      "Invalid workspace.terminal config: %s",
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
    return null;
  }

  return result.data;
}
