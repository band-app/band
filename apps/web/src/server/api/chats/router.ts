/**
 * Chats sub-routers — migrated out of the legacy `apps/web/src/trpc/router.ts`
 * in issue #316 (Phase 5 of the 3-tier refactor described in
 * `docs/web-architecture.md`).
 *
 * The router is intentionally thin: it validates input with Zod, delegates
 * to `ChatService` (and a few sibling helpers that haven't migrated yet),
 * and returns. No business logic lives here.
 *
 * Two sub-routers are exported:
 *   - `chatsRouter` covers the per-pane CRUD + message lifecycle
 *     (`chats.list`, `chats.create`, …) at the `chats.*` tRPC namespace.
 *   - `chatLayoutRouter` covers the saved dockview layout tree at the
 *     `chatLayout.*` tRPC namespace.
 *
 * Both are merged into the root router by `server/api/router.ts`. The
 * sibling helpers (`scheduleActiveSessionRefresh`, `submitTask`, …) still
 * live in `lib/` until their own phases of the refactor; routing through
 * them here is the same shape as the pre-migration legacy procedures.
 */

import { createLogger } from "@band-app/logger";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getOrCreateAgent } from "../../../lib/agent-pool";
import {
  ensureActiveSessionSummary,
  scheduleActiveSessionRefresh,
} from "../../../lib/chat-session-summary";
import { abortTask, submitTask, TaskConflictError } from "../../../lib/task-runner";
import { resolveWorkspace } from "../../../lib/workspace";
import { chatService, InvalidLabelsError } from "../../services/chat-service";
import { publicProcedure, t } from "../trpc";

const log = createLogger("chats-router");

// ---------------------------------------------------------------------------
// Chat Layout (split pane tree persistence)
// ---------------------------------------------------------------------------

export const chatLayoutRouter = t.router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { tree: chatService.getLayout(input.workspaceId) };
  }),

  save: publicProcedure
    .input(z.object({ workspaceId: z.string(), tree: z.unknown() }))
    .mutation(({ input }) => {
      chatService.saveLayout(input.workspaceId, input.tree);
      return { ok: true };
    }),
});

export type ChatLayoutRouter = typeof chatLayoutRouter;

// ---------------------------------------------------------------------------
// Chats (multi-pane chat management)
// ---------------------------------------------------------------------------

export const chatsRouter = t.router({
  list: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { chats: chatService.list(input.workspaceId) };
  }),

  create: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        id: z.string().optional(),
        name: z.string().optional(),
        agent: z.string().optional(),
        model: z.string().optional(),
        mode: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(({ input }) => {
      try {
        const chat = chatService.create(input.workspaceId, {
          id: input.id,
          name: input.name,
          agent: input.agent,
          model: input.model,
          mode: input.mode,
          labels: input.labels,
          // tRPC is a user-facing surface — never allow callers to set
          // reserved `band:`-prefixed labels.
        });
        return { chat };
      } catch (err) {
        if (err instanceof InvalidLabelsError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  get: publicProcedure.input(z.object({ chatId: z.string() })).query(async ({ input }) => {
    const chat = chatService.get(input.chatId);
    if (!chat) return { chat: null };

    const workspace = resolveWorkspace(chat.workspaceId);

    // Lazy-resolve case: row has no cached summary yet (post-migration, or
    // a fresh chat with no activeSessionId). Block once on the first read
    // so the client can render a meaningful tab title without waiting for
    // a separate sessions.list. Subsequent reads are pure SQLite.
    if (workspace && (!chat.activeSessionId || chat.activeSessionSummary === undefined)) {
      const resolved = await ensureActiveSessionSummary(input.chatId, workspace.worktree.path);
      if (resolved) {
        return { chat: resolved };
      }
    }

    // Hot path: cached values returned immediately. Kick off a
    // background refresh so the next read picks up any drift (e.g. the
    // user renamed the session via /rename). Errors are swallowed; the
    // refresh will be retried on the next request.
    if (workspace) {
      scheduleActiveSessionRefresh(input.chatId, workspace.worktree.path);
    }

    return { chat };
  }),

  /**
   * Update one or more fields on an existing chat pane.
   *
   * Behavior contract:
   *   - `labels` replaces the **full** record. Pass `{}` to clear.
   *   - Returns `NOT_FOUND` (404) if `chatId` doesn't resolve. This is
   *     a behavior change from before issue #520, when this route
   *     returned `200 { chat: undefined }` on an unknown id. The
   *     previous silent-no-op was harmless for cosmetic edits but
   *     would let a `labels: {}` "clear" against a stale id succeed
   *     misleadingly, which is why the route now surfaces the error.
   *     Existing UI callers (`ChatView.tsx` `.catch(...)` handlers
   *     for mode/model changes) absorb the new 404 the same way they
   *     absorbed the silent 200; new callers should expect it.
   *   - Returns `BAD_REQUEST` (400) if `labels` violates validation
   *     rules in `validateLabels` (max 20 keys, key regex, value
   *     rules, reserved `band:` prefix).
   */
  update: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        name: z.string().optional(),
        agent: z.string().optional(),
        // `model`/`mode` are nullable so callers can explicitly clear them
        // ("use the agent's default"). The service's `UpdateChatOptions`
        // type already accepts `string | null`; the legacy router's
        // `.string().optional()` Zod schema dropped `null` on the floor,
        // which made the "clear" path unreachable via tRPC.
        model: z.string().nullable().optional(),
        mode: z.string().nullable().optional(),
        labels: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(({ input }) => {
      const { chatId, ...updates } = input;
      try {
        const chat = chatService.update(chatId, updates);
        if (!chat) {
          // Issue #520: `chats.update` previously returned 200 with
          // `chat: undefined` when the chatId didn't resolve. Harmless when
          // the route only touched cosmetic fields, but the new `labels`
          // semantic is "replace the whole record" — a silent no-op on a
          // typo'd id would let a caller believe their relabel succeeded.
          //
          // Existing UI callers (`ChatView.tsx`'s `trpc.chats.update.mutate`
          // for `mode` / `model` changes) wrap the call in `.catch` and log
          // — they used to absorb the silent success, and they'll now
          // absorb the 404 the same way. Intentional: the 404 is the
          // correct shape for a stale chatId; any new caller (CLI
          // `chats label` / `chats unlabel`) wants it surfaced.
          throw new TRPCError({ code: "NOT_FOUND", message: "Chat not found" });
        }
        return { chat };
      } catch (err) {
        if (err instanceof InvalidLabelsError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  remove: publicProcedure.input(z.object({ chatId: z.string() })).mutation(({ input }) => {
    chatService.remove(input.chatId);
    return { ok: true };
  }),

  setActiveSession: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string(),
        sessionId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Lazily ensure the server-side chat record exists. The client
      // generates chatIds locally, so setActiveSession may be called
      // before the first message is sent (which normally creates the record).
      let chat = chatService.get(input.chatId);
      if (!chat) {
        chat = chatService.create(input.workspaceId, { id: input.chatId, name: "Chat" });
      }

      if (!input.sessionId) {
        chatService.updateActiveSession(input.chatId, undefined);
        return { ok: true };
      }

      // Resolve the summary inline so the persisted row carries a usable
      // tab title from the moment the client switches sessions. If
      // getSessionInfo fails or returns undefined (the JSONL doesn't exist
      // yet for a freshly-created session), persist NULL — the next
      // chats.get's background refresh will catch up.
      const workspace = resolveWorkspace(input.workspaceId);
      let summary: string | undefined;
      let lastModified: number | undefined;
      if (workspace) {
        try {
          const agent = await getOrCreateAgent(input.chatId, workspace.worktree.path, chat.agent);
          const info = await agent.getSessionInfo?.(input.sessionId, workspace.worktree.path);
          summary = info?.summary;
          lastModified = info?.lastModified;
        } catch (err) {
          log.warn(
            { chatId: input.chatId, sessionId: input.sessionId, err },
            "setActiveSession: getSessionInfo failed",
          );
        }
      }

      chatService.updateActiveSession(input.chatId, {
        activeSessionId: input.sessionId,
        summary,
        lastModified,
      });
      return { ok: true };
    }),

  send: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string(),
        message: z.string(),
        sessionId: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      // Lazily ensure the server-side chat record exists. The client
      // generates chatIds locally for instant rendering, so the first
      // message sent may arrive before a record is created.
      let chat = chatService.get(input.chatId);
      if (!chat) {
        chat = chatService.create(input.workspaceId, { id: input.chatId, name: "Chat" });
      }
      try {
        const task = submitTask({
          workspaceId: chat.workspaceId,
          chatId: chat.id,
          prompt: input.message,
          sessionId: input.sessionId,
        });
        return { taskId: task.id, sessionId: task.sessionId };
      } catch (err) {
        if (err instanceof TaskConflictError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Task already running for this chat pane",
          });
        }
        throw err;
      }
    }),

  stop: publicProcedure.input(z.object({ chatId: z.string() })).mutation(({ input }) => {
    abortTask(input.chatId);
    chatService.updateStatus(input.chatId, "stopped");
    return { ok: true };
  }),

  resume: publicProcedure.input(z.object({ chatId: z.string() })).mutation(({ input }) => {
    chatService.updateStatus(input.chatId, "idle");
    return { ok: true };
  }),
});

export type ChatsRouter = typeof chatsRouter;
