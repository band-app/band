import { router } from "expo-router";
import type { ChangeSection } from "./changes";

export function openFile(worktreeId: string, path: string, line?: number) {
  router.push({
    pathname: "/worktree/[id]/file",
    params: { id: worktreeId, path, ...(line ? { line: String(line) } : {}) },
  });
}

export function openDiff(
  worktreeId: string,
  file: { path: string; oldPath?: string; section: ChangeSection; mergeBase?: string | null },
) {
  router.push({
    pathname: "/worktree/[id]/diff",
    params: {
      id: worktreeId,
      path: file.path,
      section: file.section,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      ...(file.mergeBase ? { mergeBase: file.mergeBase } : {}),
    },
  });
}

export function openChanges(worktreeId: string) {
  router.push({ pathname: "/worktree/[id]/changes", params: { id: worktreeId } });
}

export function openExplorer(worktreeId: string) {
  router.push({ pathname: "/worktree/[id]/explorer", params: { id: worktreeId } });
}
