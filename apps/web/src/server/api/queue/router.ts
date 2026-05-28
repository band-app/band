import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createLogger } from "@band-app/logger";
import { z } from "zod";
import { getOrCreateDefaultChat } from "../../services/chat-manager";
import {
  clearQueuedMessages,
  getQueuedMessages,
  pushQueuedMessage,
  type QueuedMessage,
  removeQueuedMessage,
  setQueuedMessages,
  shiftQueuedMessage,
  subscribeQueue,
  toWireQueuedMessages,
  updateQueuedMessage,
} from "../../services/queued-message-store";
import { bandHome } from "../../services/state";
import { saveUploadedFilesDetailed } from "../../services/upload-utils";
import { publicProcedure, t } from "../trpc";

const log = createLogger("trpc.queue");

/**
 * Queue sub-router — migrated out of the legacy `apps/web/src/trpc/router.ts`
 * as part of Phase 8 (issue #319). Persisted queued messages: the per-chat
 * outbox that the agent drain pulls from when an agent finishes its current
 * turn, plus the dashboard's drag-to-reorder UI.
 *
 * The store lives in `server/services/queued-message-store` (an
 * in-memory store; queue state is process-local and intentionally not
 * persisted) and is consumed by the agent drain (`task-service`) and
 * the non-tRPC SSE endpoints (`api/chat-events.ts`, `api/chat-submit.ts`)
 * directly.
 */

/**
 * Wire shape accepted from tRPC clients. `path` is optional on input
 * because external/CLI callers may enqueue a raw `data:` URL that the
 * server has not yet persisted — we resolve a path in that case
 * (see `resolveQueuedFiles` below). Clients that already have the file
 * on disk (the dashboard's drag-reorder, for example) MUST forward the
 * existing `path` through unchanged so it survives the round-trip.
 */
const queuedFileSchema = z.object({
  mediaType: z.string(),
  url: z.string(),
  path: z.string().optional(),
  filename: z.string().optional(),
});

type QueuedFileInput = z.infer<typeof queuedFileSchema>;

/**
 * Reject client-supplied paths that aren't under `<HOME>/.band/uploads/`.
 * Without this, an authenticated caller (local UI, CLI, or anyone with
 * the band_token) could enqueue `path: "/home/user/.ssh/id_rsa"` — the
 * drain in `task-service.ts` would inject the path verbatim into the
 * agent prompt as `I'm sharing these files with you:\n- /…/id_rsa`,
 * and the agent would happily read and stream the contents.
 *
 * Two-layer check:
 *   1. **String containment** — normalize with `path.resolve` (catches
 *      `…/uploads/../../etc/passwd`-style traversal) and verify the
 *      result lives under the uploads dir. Pure string op, never
 *      throws, doesn't depend on the file existing.
 *   2. **Symlink defence** — if the file exists, walk symlinks with
 *      `realpathSync` and re-check containment of the canonical form,
 *      so an attacker who can place `~/.band/uploads/evil → /etc/passwd`
 *      can't bypass with a path inside the uploads dir.
 *
 * Splitting the checks avoids a previous failure mode where
 * `realpathSync` threw ENOENT on a previously-valid path (the file
 * was deleted between enqueue and use) and the attachment was
 * silently dropped from a queue.set roundtrip — see review on #500.
 * Now: missing file with a path that PASSES the string-containment
 * check is accepted (the drain may then fail to read it, surfacing
 * the issue to the user); missing file with an out-of-bounds path is
 * rejected up front.
 */
function isPathWithinUploadDir(p: string): boolean {
  const uploadDir = join(bandHome(), "uploads");
  // Layer 1: string-only containment. Catches `/etc/passwd` and any
  // `…/uploads/../../etc/passwd`-shaped traversal.
  const normalized = resolve(p);
  if (normalized !== uploadDir && !normalized.startsWith(uploadDir + sep)) {
    return false;
  }
  // Layer 2: symlink defence — only meaningful when the file actually
  // exists. `realpathSync` walks the symlink chain and returns the
  // canonical path; we then re-check containment. ENOENT means the
  // file isn't there yet (or was deleted), in which case layer 1 has
  // already accepted the normalized path — defer to the caller (the
  // drain) to surface the read failure rather than silently dropping.
  try {
    const canonicalUploadDir = realpathSync(uploadDir);
    const canonicalPath = realpathSync(p);
    return (
      canonicalPath === canonicalUploadDir || canonicalPath.startsWith(canonicalUploadDir + sep)
    );
  } catch {
    return true;
  }
}

/**
 * Ensure every enqueued file has a persisted on-disk `path`. Two shapes
 * to handle:
 *
 *   1. The client already saved the bytes (e.g. dashboard reorder via
 *      `queue.set`) and forwards `path` + a `/api/uploads/...` URL —
 *      pass through unchanged.
 *   2. The client hands us a `data:` URL with no `path` (e.g. CLI-driven
 *      enqueue from raw base64) — persist via `saveUploadedFilesDetailed`
 *      and rebuild the file record with the fresh path + stable URL.
 *
 * Any other shape (no `path`, non-data URL — there's no way to recover
 * the disk path from a bare URL) is dropped with a log entry rather
 * than silently inserted in a half-broken state.
 */
async function resolveQueuedFiles(
  chatId: string,
  files: QueuedFileInput[] | undefined,
): Promise<{ mediaType: string; url: string; path: string; filename?: string }[] | undefined> {
  if (!files || files.length === 0) return undefined;

  const resolved: { mediaType: string; url: string; path: string; filename?: string }[] = [];
  const needsSave: QueuedFileInput[] = [];
  const needsSaveIdx: number[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    // Derive path from URL when the client doesn't supply one. The
    // SSE wire shape strips `path` (it's server-internal), so the
    // dashboard's drag-reorder round-trip lands here with just
    // `url: "/api/uploads/<storedName>"`. Reconstructing the path
    // server-side keeps the wire small AND prevents a malicious
    // client from spoofing a path that doesn't match its URL.
    const uploadsUrlMatch = file.url.match(/^\/api\/uploads\/(.+)$/);
    const derivedPath =
      file.path ?? (uploadsUrlMatch ? join(bandHome(), "uploads", uploadsUrlMatch[1]) : undefined);

    if (derivedPath) {
      // Containment check — never trust a client-supplied path, even
      // a derived one (an attacker could send
      // `url: "/api/uploads/../../etc/passwd"`).
      if (!isPathWithinUploadDir(derivedPath)) {
        log.warn(
          { chatId, path: derivedPath, filename: file.filename },
          "queue: dropping file with path outside uploads directory",
        );
        continue;
      }
      resolved.push({
        mediaType: file.mediaType,
        url: file.url,
        path: derivedPath,
        ...(file.filename !== undefined && { filename: file.filename }),
      });
      continue;
    }
    if (file.url.startsWith("data:")) {
      needsSave.push(file);
      // Record the slot in `resolved[]` (NOT the loop index `i`): when an
      // earlier entry is dropped (`log.warn` branch), `resolved` lags
      // `files` and `needsSaveIdx[k] = i` would point at the wrong slot,
      // silently corrupting one entry and orphaning another.
      needsSaveIdx.push(resolved.length);
      // Placeholder so we can splice into the right slot once saved.
      resolved.push({
        mediaType: file.mediaType,
        url: file.url,
        path: "",
        filename: file.filename,
      });
      continue;
    }
    log.warn(
      { chatId, url: file.url, filename: file.filename },
      "queue: dropping file with no path and non-data URL — cannot recover disk path",
    );
  }

  if (needsSave.length > 0) {
    const saved = await saveUploadedFilesDetailed(needsSave);
    // The splicing loop below is index-aligned: `saved[k]` MUST
    // correspond to `needsSave[k]`. `saveUploadedFilesDetailed` skips
    // entries that fail its data-URL regex (compacted output) and
    // could in principle return fewer results than the input. A
    // mid-batch skip would then misalign every subsequent slot —
    // `saved[k]` would be written into a slot that belongs to a
    // different file, silently corrupting the queued payload. We
    // pre-filter for data-URL entries, so a mismatch here means an
    // upstream regression (malformed data URL slipping through). When
    // that happens, refuse to splice and let the placeholders fall
    // through to the `.filter((f) => f.path !== "")` pruning step
    // below — losing the saved-but-unmappable files is the right
    // trade-off vs. silently corrupting another file's metadata.
    if (saved.length !== needsSave.length) {
      log.error(
        { chatId, expected: needsSave.length, got: saved.length },
        "queue: saveUploadedFilesDetailed returned unexpected count — dropping data-URL files (cannot map 1:1)",
      );
    } else {
      for (let k = 0; k < saved.length; k++) {
        const target = needsSaveIdx[k];
        resolved[target] = {
          mediaType: saved[k].mediaType,
          url: `/api/uploads/${saved[k].storedName}`,
          path: saved[k].path,
          ...(saved[k].originalName !== undefined && { filename: saved[k].originalName }),
        };
      }
    }
  }

  const finalized = resolved.filter((f) => f.path !== "");
  return finalized.length > 0 ? finalized : undefined;
}

export const queueRouter = t.router({
  push: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        text: z.string(),
        files: z.array(queuedFileSchema).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      // If disk write fails (ENOSPC, permissions, etc.), degrade to a
      // text-only queue entry rather than reject the whole push with a
      // 500. Losing the attachment is annoying; losing the user's
      // typed message because their disk is full would be worse —
      // they'd have to retype it from scratch with no indication that
      // the text actually survived.
      let files: Awaited<ReturnType<typeof resolveQueuedFiles>>;
      try {
        files = await resolveQueuedFiles(chatId, input.files);
      } catch (err) {
        log.error(
          { chatId, err: err instanceof Error ? err.message : err },
          "queue.push: failed to persist file uploads; enqueuing text only",
        );
        files = undefined;
      }
      const message = pushQueuedMessage(chatId, { text: input.text, files });
      return {
        ok: true,
        message: toWireQueuedMessages([message])[0],
        messages: toWireQueuedMessages(getQueuedMessages(chatId)),
      };
    }),

  set: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        messages: z.array(
          z.object({
            id: z.string().optional(),
            text: z.string(),
            files: z.array(queuedFileSchema).optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      // Resolve files per message and tolerate per-message failures.
      // `Promise.all` would short-circuit on the first rejection and
      // leave any already-saved files orphaned on disk with no queue
      // entry referencing them. We log and drop the bad message's
      // files instead, so the reorder/set proceeds with the remaining
      // metadata intact.
      const messages = await Promise.all(
        input.messages.map(async (m) => {
          try {
            return {
              ...(m.id !== undefined && { id: m.id }),
              text: m.text,
              files: await resolveQueuedFiles(chatId, m.files),
            };
          } catch (err) {
            log.error(
              { chatId, messageId: m.id, err: err instanceof Error ? err.message : err },
              "queue: failed to resolve files for queued message; dropping its files",
            );
            return {
              ...(m.id !== undefined && { id: m.id }),
              text: m.text,
              files: undefined,
            };
          }
        }),
      );
      setQueuedMessages(chatId, messages);
      return { ok: true, messages: toWireQueuedMessages(getQueuedMessages(chatId)) };
    }),

  get: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      return { messages: toWireQueuedMessages(getQueuedMessages(chatId)) };
    }),

  remove: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional(), id: z.string() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const removed = removeQueuedMessage(chatId, input.id);
      return {
        ok: true,
        removed,
        messages: toWireQueuedMessages(getQueuedMessages(chatId)),
      };
    }),

  update: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        id: z.string(),
        text: z.string(),
      }),
    )
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const updated = updateQueuedMessage(chatId, input.id, input.text);
      return {
        ok: true,
        updated,
        messages: toWireQueuedMessages(getQueuedMessages(chatId)),
      };
    }),

  shift: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const message = shiftQueuedMessage(chatId);
      return { message: message ? toWireQueuedMessages([message])[0] : null };
    }),

  clear: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      clearQueuedMessages(chatId);
      return { ok: true };
    }),

  stream: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .subscription(async function* (opts) {
      const chatId = opts.input.chatId ?? getOrCreateDefaultChat(opts.input.workspaceId).id;

      type Update = { messages: QueuedMessage[] };
      const queue: Update[] = [];
      let resolve: (() => void) | null = null;

      const unsubscribe = subscribeQueue((id, messages) => {
        if (id !== chatId) return;
        queue.push({ messages });
        resolve?.();
      });

      opts.signal?.addEventListener("abort", () => {
        unsubscribe();
        resolve?.();
      });

      // Emit current state immediately so the client is in sync.
      // `toWireQueuedMessages` strips the server-only `path` field —
      // see queued-message-store.ts for why.
      yield { messages: toWireQueuedMessages(getQueuedMessages(chatId)) };

      // Discard notifications that arrived between listener registration
      // and the initial yield — the initial yield already covers them.
      queue.length = 0;

      try {
        while (!opts.signal?.aborted) {
          while (queue.length > 0) {
            const update = queue.shift()!;
            yield { messages: toWireQueuedMessages(update.messages) };
          }
          await new Promise<void>((r) => {
            resolve = r;
          });
          resolve = null;
        }
      } finally {
        unsubscribe();
      }
    }),
});

export type QueueRouter = typeof queueRouter;
