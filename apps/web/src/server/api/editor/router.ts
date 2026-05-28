import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { EditorOpenError, editorService } from "../../services/editor-service";
import { publicProcedure, t } from "../trpc";

/**
 * Editor sub-router — migrated into the 3-tier architecture as part of
 * Phase 7.5 (issue #517). Procedures are intentionally thin: validate with
 * Zod, delegate to `EditorService`, map errors to tRPC codes, return.
 *
 * Backs the `band open <filePath>` CLI command and the web UI's
 * "I am the currently focused workspace" hint. See the docstring on
 * `EditorService` for the security/threat model.
 */
export const editorRouter = t.router({
  // Intentionally no `getActiveWorkspace` query — the only consumer is
  // the CLI's `band open`, which reads the value implicitly through the
  // `openFile` fallback in the same round-trip. Adding a separate query
  // doubles the cost for no benefit.

  setActiveWorkspace: publicProcedure
    .input(z.object({ workspaceId: z.string().nullable() }))
    .mutation(({ input }) => {
      editorService.setActiveWorkspace(input.workspaceId);
      return { ok: true };
    }),

  openFile: publicProcedure
    .input(
      z
        .object({
          /**
           * Workspace to open the file in. When omitted, falls back to the
           * dashboard's currently active workspace.
           */
          workspaceId: z.string().optional(),
          /**
           * Either an absolute filesystem path or a workspace-relative
           * path. Paths inside the workspace root open as normal editor
           * tabs (the renderer routes to the Files panel via the
           * `open-file` SSE event; see `dispatchOpenFileEvent`); paths
           * outside any workspace root open as external tabs. May include
           * a trailing line / column suffix in the standard
           * `path:line[:column]` / `path:line-lineEnd` notation.
           */
          filePath: z.string().min(1),
          line: z.number().int().positive().optional(),
          lineEnd: z.number().int().positive().optional(),
          column: z.number().int().positive().optional(),
          /**
           * Whether the renderer should bring the dashboard window to the
           * foreground in addition to navigating to the file. Defaults to
           * true. Passed through verbatim on the SSE event; the plain web
           * build ignores it.
           */
          focus: z.boolean().optional(),
        })
        .refine((v) => !(v.lineEnd !== undefined && v.line === undefined), {
          message: "lineEnd requires line to be set",
          path: ["lineEnd"],
        })
        .refine((v) => !(v.column !== undefined && v.line === undefined), {
          message: "column requires line to be set",
          path: ["column"],
        })
        .refine((v) => !(v.line !== undefined && v.lineEnd !== undefined && v.line > v.lineEnd), {
          message: "lineEnd must be >= line",
          path: ["lineEnd"],
        }),
    )
    .mutation(({ input }) => {
      try {
        return editorService.openFile(input);
      } catch (err) {
        if (err instanceof EditorOpenError) {
          throw new TRPCError({ code: err.code, message: err.message });
        }
        throw err;
      }
    }),
});

export type EditorRouter = typeof editorRouter;
