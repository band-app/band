/**
 * Input schemas of the worktree procedures a worker's direct listener also
 * serves (`direct.ts`). The hub's `worktree.*` router validates with the
 * same schemas, so both paths accept and refuse the same input.
 */

import { z } from "zod";

/**
 * Branch names accepted by diff/revert procedures. Forbids leading `-` so the
 * value can't be interpreted by git as a flag (e.g. `--upload-pack=`, `--exec=`)
 * when it lands in `git merge-base <branch> HEAD` or `git checkout <branch> -- file`.
 * The trpc server is local-only, but `execFile` doesn't pass through a shell, so
 * a leading-dash check is enough to close the only realistic injection vector.
 */
export const compareBranchSchema = z
  .string()
  .min(1)
  .regex(/^[^-]/, "branch name must not start with '-'")
  .optional();

/**
 * `mergeBase` is the SHA returned by `getChanges` and threaded
 * back into `getFileDiff` as a revision argument to `git diff`. Pin to
 * a 40-character hex SHA: this closes the leading-dash injection
 * vector (`--exec=`, `--output=…`) AND enforces that `getFileDiff`
 * operates on the same revision shape `getChanges` returned. Real
 * merge-base SHAs from git are always 40-char hex; symbolic refs like
 * `HEAD`, `main`, or `@{-1}` are rejected so a client can't accidentally
 * desync from the Changes list's view of the world.
 */
export const mergeBaseSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "mergeBase must be a 40-character hex SHA");

/** A section of the Changes view (see `DiffService.getChanges`). */
export const changeSectionSchema = z.enum([
  "conflicts",
  "unstaged",
  "staged",
  "untracked",
  "branch",
]);

/**
 * A worktree-relative path handed to git as a pathspec. The leading-dash
 * guard keeps it from being read as a flag; the service also checks it
 * stays inside the worktree.
 */
export const filePathSchema = z.string().min(1).regex(/^[^-]/, "path must not start with '-'");

export const listFilesInput = z.object({ worktreeId: z.string(), path: z.string().default("") });

export const getFileInput = z.object({ worktreeId: z.string(), path: z.string().min(1) });

export const saveFileInput = z.object({
  worktreeId: z.string(),
  path: z.string().min(1),
  content: z.string(),
});

export const getDiffInput = z.object({
  worktreeId: z.string(),
  contextLines: z.number().int().min(0).max(99999).optional(),
  diffMode: z.enum(["uncommitted", "branch"]).optional(),
  compareBranch: compareBranchSchema,
});

export const getChangesInput = z.object({
  worktreeId: z.string(),
  compareBranch: compareBranchSchema,
});

export const getFileDiffInput = z.object({
  worktreeId: z.string(),
  filePath: filePathSchema,
  section: changeSectionSchema,
  /** Required for the `branch` section. */
  mergeBase: mergeBaseSchema.optional(),
  /** The path before a rename, so git pairs the two sides. */
  oldPath: filePathSchema.optional(),
  contextLines: z.number().int().min(0).max(99999).optional(),
});

export const searchFilesInput = z.object({
  worktreeId: z.string(),
  query: z.string().default(""),
  // Raised from 50 → 200 to match the corpus expansion in issue
  // #530: with files from nested git repos now visible to Quick
  // Open, the previous 50-entry cap could push a wanted match
  // off the result list entirely.
  limit: z.number().default(200),
});

export const searchContentInput = z.object({
  worktreeId: z.string(),
  query: z.string().min(1),
  caseSensitive: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
  regex: z.boolean().default(false),
  limit: z.number().default(100),
});

/**
 * A commit SHA passed to the commit-history procedures. Pinned to 7–40 hex
 * chars so git can never read it as a flag (`--exec=…`) or a symbolic ref:
 * the Commits panel always hands us a real object id.
 */
export const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/i, "sha must be a 7–40 character hex commit id");

export const listBranchesInput = z.object({
  worktreeId: z.string(),
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const getCommitHistoryInput = z.object({
  worktreeId: z.string(),
  skip: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const getCommitHistorySignatureInput = z.object({ worktreeId: z.string() });

export const getCommitDetailsInput = z.object({ worktreeId: z.string(), sha: commitShaSchema });

export const createFileInput = z.object({
  worktreeId: z.string(),
  path: z.string().min(1),
  content: z.string().default(""),
});

export const createDirectoryInput = z.object({ worktreeId: z.string(), path: z.string().min(1) });

export const deletePathInput = z.object({ worktreeId: z.string(), path: z.string().min(1) });

export const renamePathInput = z.object({
  worktreeId: z.string(),
  fromPath: z.string().min(1),
  toPath: z.string().min(1),
});

export const copyPathInput = renamePathInput;

export const resolvePathInput = z.object({ worktreeId: z.string(), path: z.string().min(1) });
