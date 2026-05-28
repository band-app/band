import { constants as fsConstants, open } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { createLogger } from "@band-app/logger";
import { z } from "zod";
import { browserHostService, type EnsureViewEvent } from "../../services/browser-host-service";
import { publicProcedure, t } from "../trpc";

const log = createLogger("trpc.browser-host");

/**
 * Browser host + host file-access routers — migrated into the 3-tier
 * architecture as part of Phase 7.5 (issue #517).
 *
 * Two sub-routers share this file because they're both about "the desktop
 * host's filesystem and browser views":
 *
 *   - `hostRouter`        — `host.readFile` / `host.saveFile` for the
 *     external file viewer (paths outside any worktree).
 *   - `browserHostRouter` — bridge between the web server and the
 *     desktop's BrowserViewManager. See the docstring on
 *     `server/infra/browser-host/host-state.ts` for the full ensure/destroy
 *     protocol; the `BrowserHostService` wrapper in services/ keeps the
 *     router from importing infra directly.
 *
 * Both used to live inline in `apps/web/src/trpc/router.ts`.
 */

// `host` file-ops: cap at 1MB so a misbehaving caller can't fill the
// disk via the save endpoint while the read endpoint refuses anything
// wider.
const MAX_FILE_SIZE = 1024 * 1024;

const LANG_MAP: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".sh": "bash",
  ".sql": "sql",
  ".graphql": "graphql",
  ".vue": "vue",
  ".svelte": "svelte",
  ".diff": "diff",
};

function mapFsError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new Error("File not found");
  if (code === "ELOOP") return new Error("Symbolic links are not allowed");
  if (code === "EACCES" || code === "EPERM") return new Error("Permission denied");
  if (code === "EISDIR") return new Error("Cannot operate on a directory");
  return err instanceof Error ? err : new Error(String(err));
}

export const hostRouter = t.router({
  readFile: publicProcedure
    .input(z.object({ absolutePath: z.string().min(1) }))
    .query(async ({ input }) => {
      const target = input.absolutePath;
      if (!isAbsolute(target)) {
        throw new Error("Absolute path required");
      }

      // O_RDONLY | O_NOFOLLOW: refuse to traverse a symlink. The kernel
      // returns ELOOP if the final path component is a symlink, which
      // we surface as "Symbolic links are not allowed" via mapFsError.
      let fh: Awaited<ReturnType<typeof open>>;
      try {
        fh = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (err) {
        throw mapFsError(err);
      }
      try {
        const stats = await fh.stat();
        if (stats.isDirectory()) {
          throw new Error("Cannot operate on a directory");
        }
        if (!stats.isFile()) {
          throw new Error("Not a regular file");
        }
        const size = stats.size;

        if (size > MAX_FILE_SIZE) {
          return { tooLarge: true as const, size };
        }

        // Sample the first 8KB to detect binary content before allocating
        // a buffer for the full file. For a binary file that's the whole
        // story; for a text file we then read the rest.
        const sampleLen = Math.min(8192, size);
        const sample = Buffer.alloc(sampleLen);
        if (sampleLen > 0) {
          await fh.read(sample, 0, sampleLen, 0);
          if (sample.includes(0)) {
            return { binary: true as const, size };
          }
        }

        const buffer = await fh.readFile();
        const ext = extname(target).toLowerCase();
        const language = LANG_MAP[ext];

        return {
          content: buffer.toString("utf-8"),
          size,
          language,
        };
      } finally {
        await fh.close();
      }
    }),

  saveFile: publicProcedure
    .input(
      z.object({
        absolutePath: z.string().min(1),
        // Match the read-side cap so a misbehaving client can't fill
        // disk via the save endpoint while the read endpoint refuses
        // anything that wide.
        content: z.string().max(MAX_FILE_SIZE),
      }),
    )
    .mutation(async ({ input }) => {
      const target = input.absolutePath;
      if (!isAbsolute(target)) {
        throw new Error("Absolute path required");
      }

      // O_WRONLY | O_TRUNC | O_NOFOLLOW: open the existing file
      // exclusively for writing (no symlink traversal, no follow-up
      // syscall window for an attacker to swap a symlink in). Crucially
      // we do NOT pass O_CREAT — saveFile is a write-back of an
      // existing file, not a create.
      let fh: Awaited<ReturnType<typeof open>>;
      try {
        fh = await open(
          target,
          fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
        );
      } catch (err) {
        throw mapFsError(err);
      }
      try {
        const stats = await fh.stat();
        if (stats.isDirectory()) {
          throw new Error("Cannot operate on a directory");
        }
        if (!stats.isFile()) {
          throw new Error("Not a regular file");
        }
        await fh.writeFile(input.content, "utf-8");
      } finally {
        await fh.close();
      }

      return { ok: true };
    }),
});

export const browserHostRouter = t.router({
  // Diagnostic: the desktop's BrowserHostBridge calls this on mount so we
  // can confirm in the server log that the bridge component actually
  // executed. Drop once the experiment is stable.
  ping: publicProcedure.input(z.object({ where: z.string() })).mutation(({ input }) => {
    log.info("browserHost.ping from %s", input.where);
    return { ok: true };
  }),

  ensureView: publicProcedure.subscription(async function* (opts) {
    const queue: EnsureViewEvent[] = [];
    let resolve: (() => void) | null = null;

    const unsubscribe = browserHostService.onEnsureView((event) => {
      queue.push(event);
      resolve?.();
    });

    opts.signal?.addEventListener("abort", () => {
      unsubscribe();
      resolve?.();
    });

    try {
      while (!opts.signal?.aborted) {
        while (queue.length > 0) {
          yield queue.shift()!;
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

  targetReady: publicProcedure
    .input(z.object({ bandTabId: z.string(), cdpTargetId: z.string() }))
    .mutation(({ input }) => {
      browserHostService.resolveTargetReady(input.bandTabId, input.cdpTargetId);
      return { ok: true };
    }),

  viewDestroyed: publicProcedure
    .input(z.object({ bandTabId: z.string() }))
    .mutation(({ input }) => {
      browserHostService.markTargetDestroyed(input.bandTabId);
      return { ok: true };
    }),
});

export type HostRouter = typeof hostRouter;
export type BrowserHostRouter = typeof browserHostRouter;
