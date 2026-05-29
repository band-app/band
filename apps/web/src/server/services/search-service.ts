/**
 * Workspace search service — file-name fuzzy search (over `git ls-files`)
 * and content search (over ripgrep, via `infra/search/ripgrep-client`).
 * Lifted out of `api/workspace/router.ts` (issue #535, follow-up 1) so
 * the router contains validation + delegation only.
 *
 * The shell-out lives in `infra/search/ripgrep-client.ts`; this service
 * applies the business decisions on top of the raw match stream (limit
 * cap, cancellation on cap-hit, workspace resolution).
 */

import { WorkspaceNotFoundError } from "../errors";
import { execGit } from "../infra/git/git-client";
import { streamMatches } from "../infra/search/ripgrep-client";
import { fuzzyScore } from "./fuzzy-score";
import { workspaceService as defaultWorkspaceService, type WorkspaceService } from "./workspace-service";

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
   * Falls back to a plain `git ls-files` listing when `query` is empty —
   * the caller (file palette) can use that for an initial unfiltered view.
   * Respects `.gitignore` because `git ls-files --others --exclude-standard`
   * already does.
   */
  async searchFiles(
    workspaceId: string,
    options: SearchFilesOptions,
  ): Promise<{ files: string[] }> {
    const workspace = this.workspaces.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const limit = options.limit ?? 50;
    const cwd = workspace.worktree.path;
    const output = await execGit(["ls-files", "--cached", "--others", "--exclude-standard"], cwd);

    let files = output.trim().split("\n").filter(Boolean);

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
