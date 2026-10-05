/**
 * `context.*`: the context repos the hub holds (plan step 5.1). Every
 * procedure needs an admin device token. The MCP endpoint and the worker relay
 * leave the router out: an agent reads and writes a context through git, with
 * a token the hub gave its host.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ContextInputError, ContextNotFoundError } from "../../errors";
import {
  ContextConflictError,
  contextBrowserService,
} from "../../services/context-browser-service";
import { contextService } from "../../services/context-service";
import { adminProcedure, t } from "../trpc";

const name = z.string().trim().min(1).max(63);
const labels = z.array(z.string().min(1).max(100)).max(20);
const repos = z.array(z.string().min(1).max(200)).max(100);
const workerAccess = z.enum(["read-write", "read-only"]);

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ContextNotFoundError) {
      throw new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (err instanceof ContextConflictError) {
      throw new TRPCError({ code: "CONFLICT", message: err.message });
    }
    if (err instanceof ContextInputError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    throw err;
  }
}

export const contextRouter = t.router({
  list: adminProcedure.query(() => ({ contexts: contextService.list() })),

  create: adminProcedure
    .input(
      z.object({
        name,
        kind: z.enum(["user", "project"]).optional(),
        labels: labels.optional(),
        repos: repos.optional(),
        workerAccess: workerAccess.optional(),
        remoteUrl: z.string().max(500).optional(),
        remoteVaultItemId: z.string().min(1).optional(),
      }),
    )
    .mutation(({ input }) => guard(async () => ({ context: await contextService.create(input) }))),

  update: adminProcedure
    .input(
      z.object({
        name,
        labels: labels.optional(),
        repos: repos.optional(),
        workerAccess: workerAccess.optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(() => ({
        context: contextService.update(input.name, {
          labels: input.labels,
          repos: input.repos,
          workerAccess: input.workerAccess,
        }),
      })),
    ),

  remove: adminProcedure
    .input(z.object({ name }))
    .mutation(({ input }) =>
      guard(() => contextService.remove(input.name).then(() => ({ removed: true }))),
    ),

  /** A null `remoteUrl` unlinks. */
  linkRemote: adminProcedure
    .input(
      z.object({
        name,
        remoteUrl: z.string().max(500).nullable(),
        vaultItemId: z.string().min(1).nullable().optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(async () => ({
        context: await contextService.linkRemote(input.name, input.remoteUrl, input.vaultItemId),
      })),
    ),

  /** What worker syncs reported: kept-both conflicts and files the redaction scan held back. */
  events: adminProcedure
    .input(z.object({ name: name.optional(), limit: z.number().int().min(1).max(200).optional() }))
    .query(({ input }) => ({
      events: contextService.events(input.limit ?? 50, input.name),
    })),

  /** Mirrors with the remote now. */
  sync: adminProcedure
    .input(z.object({ name }))
    .mutation(({ input }) => guard(() => contextService.sync(input.name))),

  // ---- the context browser (plan step 5.5) ----

  /** Every file of the context at its current head, with conflict copies marked. */
  tree: adminProcedure
    .input(z.object({ name }))
    .query(({ input }) => guard(() => contextBrowserService.tree(input.name))),

  file: adminProcedure
    .input(z.object({ name, path: z.string().min(1).max(500) }))
    .query(({ input }) => guard(() => contextBrowserService.file(input.name, input.path))),

  /** Commits that touched the context, or one file when `path` is set. */
  log: adminProcedure
    .input(
      z.object({
        name,
        path: z.string().min(1).max(500).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(({ input }) =>
      guard(async () => ({
        commits: await contextBrowserService.log(input.name, input.path, input.limit),
      })),
    ),

  diff: adminProcedure
    .input(
      z.object({ name, sha: z.string().length(40), path: z.string().min(1).max(500).optional() }),
    )
    .query(({ input }) =>
      guard(() => contextBrowserService.diff(input.name, input.sha, input.path)),
    ),

  /** The newest files under learnings/ and handoffs/. */
  recent: adminProcedure
    .input(z.object({ name, limit: z.number().int().min(1).max(100).optional() }))
    .query(({ input }) =>
      guard(async () => ({ entries: await contextBrowserService.recent(input.name, input.limit) })),
    ),

  /** Saves a file as one commit. `base` is the commit the editor loaded the file at. */
  write: adminProcedure
    .input(
      z.object({
        name,
        path: z.string().min(1).max(500),
        content: z.string(),
        message: z.string().min(1).max(200),
        base: z.string().length(40).optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(() =>
        contextBrowserService.write(
          input.name,
          input.path,
          input.content,
          input.message,
          input.base,
        ),
      ),
    ),

  /** Keeps one version of a conflicted file and deletes the conflict copy. */
  resolveConflict: adminProcedure
    .input(
      z.object({
        name,
        path: z.string().min(1).max(500),
        keep: z.enum(["original", "conflict"]),
        message: z.string().min(1).max(200).optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(() =>
        contextBrowserService.resolveConflict(input.name, input.path, input.keep, input.message),
      ),
    ),
});
