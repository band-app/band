import { createLogger } from "@band-app/logger";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { WorkspaceNotFoundError } from "../../errors";
import { saveUploadedFilesDetailed } from "../../services/_utils/upload-utils";
import { chatService } from "../../services/chat-service";
import { loadState } from "../../services/state";
import { TaskConflictError, taskService } from "../../services/task-service";
import { publicProcedure, t } from "../trpc";

interface SubmitResult {
  id: string;
  workspaceId: string;
  chatId: string;
  sessionId: string | undefined;
}

interface RerunResult {
  workspaceId: string;
  chatId: string;
  sessionId: string | undefined;
}

const log = createLogger("tasks-router");

/**
 * Tasks sub-router (Phase 6 of the 3-tier migration — issue #317).
 *
 * Body is intentionally thin and delegates to `TaskService` (a.k.a. the
 * function exports in `services/task-service.ts`). Per
 * `docs/web-architecture.md` the router never imports from
 * `infra/`; persisted-task reads (`list`, `rerun`) go through the
 * `listTaskRecords` / `loadTaskRecord` service façades so the only direct
 * `TaskQueries` consumer is the service tier. The legacy task procedures
 * lived under `tasksRouter` in `apps/web/src/trpc/router.ts`; this file
 * replaces them and is merged into the root `appRouter` in
 * `server/api/router.ts`. The corresponding key is dropped from the
 * legacy router in the same diff per the migration invariant documented
 * there.
 *
 * Service-level domain errors (`TaskConflictError`,
 * `WorkspaceNotFoundError`) are translated into tRPC error codes here so
 * the service tier stays framework-agnostic and remains reusable by
 * non-tRPC entry points (CLI, scripts, future REST surface).
 */

export const tasksRouter = t.router({
  list: publicProcedure
    .input(
      z
        .object({
          project: z.string().optional(),
          workspaceId: z.string().optional(),
          status: z.enum(["running", "completed", "failed"]).optional(),
          sessionId: z.string().optional(),
          chatId: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      const tasks = taskService.listTaskRecords(input);
      const state = loadState();
      const workspaceIds = new Set<string>();
      for (const p of state.projects) {
        for (const wt of p.worktrees) {
          workspaceIds.add(wt.id);
        }
      }
      return {
        tasks: tasks.map((row) => ({
          ...row,
          workspaceExists: workspaceIds.has(row.workspaceId),
        })),
      };
    }),

  submit: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        prompt: z.string(),
        sessionId: z.string().optional(),
        mode: z.string().optional(),
        model: z.string().optional(),
        codingAgentId: z.string().optional(),
        files: z
          .array(
            z.object({
              mediaType: z.string(),
              url: z.string(),
              filename: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ input }): Promise<SubmitResult> => {
      // Explicit return-type annotation pins the wire contract even though
      // TypeScript infers `Promise<SubmitResult>` correctly today (the
      // `never` from `throwAsTrpcError` is propagated out of the catch).
      // Pinning the annotation guards against a future edit that adds an
      // unguarded code path silently widening the procedure's return union.
      // Same pattern in `rerun` below and in `sessions/router.ts`.
      // Resolve chatId: if the client provides one, lazily ensure the server
      // record exists. If not provided, fall back to the default chat.
      let chatId: string;
      if (input.chatId) {
        const existing = chatService.get(input.chatId);
        if (!existing) {
          // Lazily create the chat record. Preserve the agent from the
          // task so the correct agent type is used (not the default).
          chatService.create(input.workspaceId, {
            id: input.chatId,
            name: "Chat",
            agent: input.codingAgentId,
          });
        }
        chatId = input.chatId;
      } else {
        chatId = chatService.getOrCreateDefault(input.workspaceId).id;
      }

      // Persist any uploaded files first and capture the full SavedFile
      // records so we can build BOTH the agent prompt (which references
      // absolute on-disk paths) AND the displayFiles array (which carries
      // the stable `/api/uploads/<storedName>` URL + media type for the
      // user-bubble rendering and JSONL replay). This mirrors the legacy
      // `chat-submit.ts` flow — without `displayFiles`, the user bubble
      // would be text-only on any page refresh and the JSONL replay path
      // would have no `file` parts. See chat-submit.ts:106-126 for the
      // canonical shape.
      let agentPrompt: string | undefined;
      let displayFiles: { mediaType: string; url: string; filename?: string }[] | undefined;
      if (input.files && input.files.length > 0) {
        const savedFiles = await saveUploadedFilesDetailed(input.files);
        // Surface the count mismatch when `saveUploadedFilesDetailed`
        // silently skips an entry (its data-URL regex requires the exact
        // `data:<mime>;base64,...` shape, so a malformed payload from a
        // non-browser client — CLI, curl, third-party — would otherwise
        // disappear into a 200 OK with no signal back to the caller).
        // Mirrors the warning in `chat-submit.ts:112-117`.
        if (savedFiles.length !== input.files.length) {
          log.warn(
            { chatId, submitted: input.files.length, saved: savedFiles.length },
            "tasks.submit: some file uploads were dropped (malformed data URL?)",
          );
        }
        if (savedFiles.length > 0) {
          const fileList = savedFiles.map((s) => `- ${s.path}`).join("\n");
          agentPrompt = `I'm sharing these files with you:\n${fileList}\n\n${input.prompt}`;
          displayFiles = savedFiles.map((s) => ({
            mediaType: s.mediaType,
            url: `/api/uploads/${s.storedName}`,
            filename: s.originalName,
          }));
        }
      }

      try {
        const task = taskService.submitTask({
          workspaceId: input.workspaceId,
          chatId,
          prompt: input.prompt,
          sessionId: input.sessionId,
          agentPrompt,
          displayFiles,
          mode: input.mode,
          model: input.model,
          codingAgentId: input.codingAgentId,
        });
        return {
          id: task.id,
          workspaceId: task.workspaceId,
          chatId: task.chatId,
          sessionId: task.sessionId,
        };
      } catch (err) {
        throwAsTrpcError(err);
      }
    }),

  get: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(({ input }) => {
      const chatId = input.chatId ?? chatService.getOrCreateDefault(input.workspaceId).id;
      const task = taskService.getTask(chatId);
      return { task };
    }),

  /**
   * Lightweight existence check — used by the client during reconnect retries
   * to distinguish "server says nothing's running, give up" from "server says
   * a task IS running, keep retrying". This avoids a noisy `task` payload
   * round-trip on every retry tick.
   */
  isRunning: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(({ input }) => {
      const chatId = input.chatId ?? chatService.getOrCreateDefault(input.workspaceId).id;
      const task = taskService.getTask(chatId);
      return { running: task?.status === "running" };
    }),

  abort: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? chatService.getOrCreateDefault(input.workspaceId).id;
      const aborted = taskService.abortTask(chatId);
      if (!aborted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No running task found" });
      }
      return { aborted: true };
    }),

  cancel: publicProcedure.input(z.object({ taskId: z.string() })).mutation(({ input }) => {
    const result = taskService.cancelTask(input.taskId);
    if (!result.cancelled) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Task not found or not running",
      });
    }
    return { cancelled: true };
  }),

  rerun: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ input }): RerunResult => {
      // Explicit return type — see comment on `submit` above.
      const record = taskService.loadTaskRecord(input.taskId);
      if (!record) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      }

      // Use original chat pane or default for workspace
      const chatId = record.chatId ?? chatService.getOrCreateDefault(record.workspaceId).id;

      try {
        const task = taskService.submitTask({
          workspaceId: record.workspaceId,
          chatId,
          prompt: record.prompt,
          mode: record.mode,
          model: record.model,
          codingAgentId: record.codingAgentId,
        });
        return { workspaceId: task.workspaceId, chatId: task.chatId, sessionId: task.sessionId };
      } catch (err) {
        throwAsTrpcError(err);
      }
    }),
});

export type TasksRouter = typeof tasksRouter;

/**
 * Translate `TaskService` domain errors into `TRPCError`s and throw.
 *
 * Always throws — the `: never` return type lets call sites do
 * `throwAsTrpcError(err)` without a redundant `throw` keyword and forces
 * TypeScript to treat the line as terminal control flow (same convention
 * as the cronjobs router).
 *
 *   - `TaskConflictError` → 409 `CONFLICT` (a task is already running for
 *     this chat pane)
 *   - `WorkspaceNotFoundError` → 404 `NOT_FOUND`. Matched by `instanceof`
 *     rather than message-string (the legacy router did
 *     `err.message.startsWith("Workspace not found")`, which was fragile
 *     across the service-tier boundary).
 *
 * Anything else is rethrown unchanged so unexpected failures surface as a
 * 500 with the original stack rather than being silently swallowed.
 */
function throwAsTrpcError(err: unknown): never {
  if (err instanceof TaskConflictError) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Task already running for this chat pane",
    });
  }
  if (err instanceof WorkspaceNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  throw err;
}
