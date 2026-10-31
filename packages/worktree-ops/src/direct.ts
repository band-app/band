/**
 * One definition per procedure of the local direct path: its input schema and
 * the service call. The hub's `worktree.*` router and a worker's direct
 * listener both run these, so a call answers the same on either path.
 */

import type { DirectProcedure } from "@band-app/shared/direct-access";
import type { z } from "zod";
import type { DiffService } from "./diff";
import type { FilesService } from "./files";
import type { GitGraphService } from "./git-graph";
import {
  createDirectoryInput,
  createFileInput,
  deletePathInput,
  getChangesInput,
  getCommitDetailsInput,
  getCommitHistoryInput,
  getCommitHistorySignatureInput,
  getDiffInput,
  getFileDiffInput,
  getFileInput,
  listBranchesInput,
  listFilesInput,
  renamePathInput,
  saveFileInput,
  searchContentInput,
  searchFilesInput,
} from "./schemas";
import type { SearchService } from "./search";

export interface WorktreeOps {
  files: FilesService;
  diff: DiffService;
  search: SearchService;
  gitGraph: GitGraphService;
}

interface Op<S extends z.ZodTypeAny, R> {
  input: S;
  run(ops: WorktreeOps, input: z.output<S>): Promise<R>;
}

const op = <S extends z.ZodTypeAny, R>(o: Op<S, R>): Op<S, R> => o;

export const directOps = {
  "worktree.listFiles": op({
    input: listFilesInput,
    run: (ops, i) => ops.files.listFiles(i.worktreeId, i.path),
  }),
  "worktree.getFile": op({
    input: getFileInput,
    run: (ops, i) => ops.files.getFile(i.worktreeId, i.path),
  }),
  "worktree.saveFile": op({
    input: saveFileInput,
    run: (ops, i) => ops.files.saveFile(i.worktreeId, i.path, i.content),
  }),
  "worktree.getDiff": op({
    input: getDiffInput,
    run: (ops, i) =>
      ops.diff.getDiff(i.worktreeId, {
        contextLines: i.contextLines,
        diffMode: i.diffMode,
        compareBranch: i.compareBranch,
      }),
  }),
  "worktree.getChanges": op({
    input: getChangesInput,
    run: (ops, i) => ops.diff.getChanges(i.worktreeId, { compareBranch: i.compareBranch }),
  }),
  "worktree.getFileDiff": op({
    input: getFileDiffInput,
    run: (ops, i) =>
      ops.diff.getFileDiff(i.worktreeId, {
        filePath: i.filePath,
        section: i.section,
        mergeBase: i.mergeBase,
        oldPath: i.oldPath,
        contextLines: i.contextLines,
      }),
  }),
  "worktree.searchFiles": op({
    input: searchFilesInput,
    run: (ops, i) => ops.search.searchFiles(i.worktreeId, { query: i.query, limit: i.limit }),
  }),
  "worktree.searchContent": op({
    input: searchContentInput,
    run: (ops, i) =>
      ops.search.searchContent(i.worktreeId, {
        query: i.query,
        caseSensitive: i.caseSensitive,
        wholeWord: i.wholeWord,
        regex: i.regex,
        limit: i.limit,
      }),
  }),
  "worktree.listBranches": op({
    input: listBranchesInput,
    run: (ops, i) => ops.diff.listBranches(i.worktreeId, { query: i.query, limit: i.limit }),
  }),
  "worktree.getCommitHistory": op({
    input: getCommitHistoryInput,
    run: (ops, i) => ops.gitGraph.getCommitHistory(i.worktreeId, { skip: i.skip, limit: i.limit }),
  }),
  "worktree.getCommitHistorySignature": op({
    input: getCommitHistorySignatureInput,
    run: (ops, i) => ops.gitGraph.getCommitHistorySignature(i.worktreeId),
  }),
  "worktree.getCommitDetails": op({
    input: getCommitDetailsInput,
    run: (ops, i) => ops.gitGraph.getCommitDetails(i.worktreeId, i.sha),
  }),
  "worktree.createFile": op({
    input: createFileInput,
    run: (ops, i) => ops.files.createFile(i.worktreeId, i.path, i.content),
  }),
  "worktree.createDirectory": op({
    input: createDirectoryInput,
    run: (ops, i) => ops.files.createDirectory(i.worktreeId, i.path),
  }),
  "worktree.deletePath": op({
    input: deletePathInput,
    run: (ops, i) => ops.files.deletePath(i.worktreeId, i.path),
  }),
  "worktree.renamePath": op({
    input: renamePathInput,
    run: (ops, i) => ops.files.renamePath(i.worktreeId, i.fromPath, i.toPath),
  }),
  "worktree.copyPath": op({
    input: renamePathInput,
    run: (ops, i) => ops.files.copyPath(i.worktreeId, i.fromPath, i.toPath),
  }),
} satisfies Record<DirectProcedure, Op<z.ZodTypeAny, unknown>>;
