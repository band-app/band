/**
 * Worktree search service — file-name fuzzy search and content search,
 * both backed by ripgrep via `infra/search/ripgrep-client`. Lifted out
 * of `api/worktree/router.ts` (issue #535, follow-up 1) so the router
 * contains validation + delegation only.
 *
 * The shell-out lives in `infra/search/ripgrep-client.ts`, reached through
 * the worktree's host (`host.search`); this service
 * applies the business decisions on top of the raw match stream (limit
 * cap, cancellation on cap-hit, worktree resolution).
 *
 * `searchFiles` used to call `git ls-files --cached --others
 * --exclude-standard`, but that command refuses to descend into nested
 * git repositories — so a worktree whose subdirectories were
 * independently-cloned repos lost every file outside the outer worktree
 * (issue #530). We now use `rg --files` which walks the directory tree
 * directly, surfacing files in nested repos / submodules while still
 * respecting the worktree's own `.gitignore` / `.rgignore`.
 */

import { WorktreeNotFoundError } from "../errors";
import { scoreFiles } from "./_utils/fuzzy-score";
import {
  worktreeService as defaultWorktreeService,
  type WorktreeService,
} from "./worktree-service";

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
  constructor(private readonly worktrees: WorktreeService = defaultWorktreeService) {}

  /**
   * Fuzzy-search file names within a worktree.
   *
   * Falls back to a plain `rg --files` listing when `query` is empty —
   * the caller (file palette) can use that for an initial unfiltered
   * view. Respects the worktree's own `.gitignore` / `.rgignore`
   * because that's what ripgrep does by default; the user's global
   * `~/.gitignore` is deliberately ignored so every contributor sees
   * the same corpus (see `ripgrep-client.ts::listFiles` for the full
   * flag rationale).
   */
  async searchFiles(worktreeId: string, options: SearchFilesOptions): Promise<{ files: string[] }> {
    const worktree = this.worktrees.resolve(worktreeId);
    if (!worktree) throw new WorktreeNotFoundError(worktreeId);

    // Limit cap raised from 50 → 200 alongside the corpus expansion
    // (issue #530): with files from nested git repos now in the corpus,
    // the previous 50-entry cap could push a wanted match off the list
    // entirely when the user typed a short query.
    const limit = options.limit ?? 200;
    const files = await worktree.host.search.listFiles(worktree.worktree.path);

    if (!options.query) {
      // Empty query → just return the raw listing capped to `limit`.
      // The file picker uses this for its initial unfiltered view.
      return { files: files.slice(0, limit) };
    }

    // Score + sort the whole corpus in one `Fzf` pass. Returns only
    // matches, sorted highest-first with the filename bonus and length
    // tiebreaker already applied; we just slice to the limit here.
    const scored = scoreFiles(options.query, files);
    return { files: scored.slice(0, limit).map((r) => r.file) };
  }

  /**
   * Find-in-files. The shell-out itself lives in
   * `infra/search/ripgrep-client.ts` and runs on the worktree's host; this method drives it with the
   * service's `limit` policy (stop iterating + let the child be torn
   * down via the async-iterator's `return()` once the cap is hit).
   *
   * ripgrep is preferred over `git grep` because Band worktrees
   * frequently contain untracked files (agents create files that aren't
   * yet `git add`-ed) and those would otherwise be invisible to
   * find-in-files. ripgrep respects `.gitignore` by default, matching
   * `git grep`'s effective filter for tracked files while also surfacing
   * untracked-but-not-ignored ones.
   */
  async searchContent(
    worktreeId: string,
    options: SearchContentOptions,
  ): Promise<{ results: SearchContentMatch[] }> {
    const worktree = this.worktrees.resolve(worktreeId);
    if (!worktree) throw new WorktreeNotFoundError(worktreeId);

    const limit = options.limit ?? 100;
    const results: SearchContentMatch[] = [];
    const iter = worktree.host.search.stream(
      {
        query: options.query,
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        regex: options.regex,
      },
      worktree.worktree.path,
    );

    for await (const match of iter) {
      results.push(match);
      if (results.length >= limit) break;
    }

    return { results };
  }
}

export const searchService = new SearchService();
