/**
 * Workspace search service — file-name fuzzy search and content search,
 * both backed by ripgrep via `infra/search/ripgrep-client`. Lifted out
 * of `api/workspace/router.ts` (issue #535, follow-up 1) so the router
 * contains validation + delegation only.
 *
 * The shell-out lives in `infra/search/ripgrep-client.ts`; this service
 * applies the business decisions on top of the raw match stream (limit
 * cap, cancellation on cap-hit, workspace resolution).
 *
 * `searchFiles` used to call `git ls-files --cached --others
 * --exclude-standard`, but that command refuses to descend into nested
 * git repositories — so a workspace whose subdirectories were
 * independently-cloned repos lost every file outside the outer worktree
 * (issue #530). We now use `rg --files` which walks the directory tree
 * directly, surfacing files in nested repos / submodules while still
 * respecting the workspace's own `.gitignore` / `.rgignore`.
 */

import { WorkspaceNotFoundError } from "../errors";
import { listFiles, streamMatches } from "../infra/search/ripgrep-client";
import { fuzzyScore } from "./_utils/fuzzy-score";
import {
  workspaceService as defaultWorkspaceService,
  type WorkspaceService,
} from "./workspace-service";

export interface SearchFilesOptions {
  query: string;
  limit?: number;
}

export interface SearchContentOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  limit?: number;
}

export interface SearchContentMatch {
  file: string;
  line: number;
  content: string;
}

export class SearchService {
  constructor(private readonly workspaces: WorkspaceService = defaultWorkspaceService) {}

  /**
   * Fuzzy-search file names within a workspace.
   *
   * Falls back to a plain `rg --files` listing when `query` is empty —
   * the caller (file palette) can use that for an initial unfiltered
   * view. Respects the workspace's own `.gitignore` / `.rgignore`
   * because that's what ripgrep does by default; the user's global
   * `~/.gitignore` is deliberately ignored so every contributor sees
   * the same corpus (see `ripgrep-client.ts::listFiles` for the full
   * flag rationale).
   */
  async searchFiles(
    workspaceId: string,
    options: SearchFilesOptions,
  ): Promise<{ files: string[] }> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    // Limit cap raised from 50 → 200 alongside the corpus expansion
    // (issue #530): with files from nested git repos now in the corpus,
    // the previous 50-entry cap could push a wanted match off the list
    // entirely when the user typed a short query.
    const limit = options.limit ?? 200;
    let files = await listFiles(workspace.worktree.path);

    if (options.query) {
      const scored: { file: string; score: number }[] = [];
      for (const f of files) {
        const score = fuzzyScore(options.query, f);
        if (score !== null) scored.push({ file: f, score });
      }
      scored.sort((a, b) => b.score - a.score);
      files = scored.map((r) => r.file);
    }

    return { files: files.slice(0, limit) };
  }

  /**
   * Find-in-files. The shell-out itself lives in
   * `infra/search/ripgrep-client.ts`; this method drives it with the
   * service's `limit` policy (stop iterating + let the child be torn
   * down via the async-iterator's `return()` once the cap is hit).
   *
   * ripgrep is preferred over `git grep` because Band workspaces
   * frequently contain untracked files (agents create files that aren't
   * yet `git add`-ed) and those would otherwise be invisible to
   * find-in-files. ripgrep respects `.gitignore` by default, matching
   * `git grep`'s effective filter for tracked files while also surfacing
   * untracked-but-not-ignored ones.
   */
  async searchContent(
    workspaceId: string,
    options: SearchContentOptions,
  ): Promise<{ results: SearchContentMatch[] }> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const limit = options.limit ?? 100;
    const results: SearchContentMatch[] = [];
    const iter = streamMatches({
      query: options.query,
      cwd: workspace.worktree.path,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      regex: options.regex,
    });

    for await (const match of iter) {
      results.push(match);
      if (results.length >= limit) break;
    }

    return { results };
  }
}

export const searchService = new SearchService();
