/**
 * Workspace search service — file-name fuzzy search (over `git ls-files`)
 * and content search (over ripgrep). Lifted out of `api/workspace/router.ts`
 * (issue #535, follow-up 1) so the router contains validation + delegation
 * only.
 *
 * ripgrep is preferred over `git grep` because Band workspaces frequently
 * contain untracked files (agents create files that aren't yet `git add`-ed)
 * and those would otherwise be invisible to find-in-files. ripgrep respects
 * `.gitignore` by default, matching `git grep`'s effective filter for
 * tracked files while also surfacing untracked-but-not-ignored ones.
 */

import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import { WorkspaceNotFoundError } from "../errors";
import { execGit } from "../infra/git/git-client";
import { fuzzyScore } from "./fuzzy-score";
import { workspaceService } from "./workspace-service";

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
    const workspace = workspaceService.resolve(workspaceId);
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
   * Find-in-files via ripgrep. Streams ripgrep's `--json` output and
   * resolves with at most `limit` matches; on hitting the cap we SIGTERM
   * the child so it doesn't keep scanning.
   */
  searchContent(
    workspaceId: string,
    options: SearchContentOptions,
  ): Promise<{ results: SearchContentMatch[] }> {
    const workspace = workspaceService.resolve(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

    const cwd = workspace.worktree.path;
    const limit = options.limit ?? 100;

    const args: string[] = [];
    if (!options.caseSensitive) args.push("--ignore-case");
    if (options.wholeWord) args.push("--word-regexp");
    if (!options.regex) args.push("--fixed-strings");
    args.push("--json");
    // Pass the cwd as an explicit search path. Without a path argument,
    // ripgrep reads from stdin when its stdin is not a tty — under
    // `spawn` (which defaults to a piped stdin) that hangs forever.
    args.push("--", options.query, "./");

    return new Promise<{ results: SearchContentMatch[] }>((resolvePromise, rejectPromise) => {
      const results: SearchContentMatch[] = [];
      // `stdio: ['ignore', 'pipe', 'pipe']` also closes stdin so ripgrep
      // can't fall back into stdin-reading mode.
      const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdoutBuf = "";
      let stderrBuf = "";
      let settled = false;
      let killed = false;

      const finish = (value: SearchContentMatch[]) => {
        if (settled) return;
        settled = true;
        resolvePromise({ results: value });
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        rejectPromise(err);
      };

      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        stdoutBuf += chunk;
        // ripgrep --json emits one JSON object per line.
        while (true) {
          const nlIdx = stdoutBuf.indexOf("\n");
          if (nlIdx === -1) break;
          const line = stdoutBuf.slice(0, nlIdx);
          stdoutBuf = stdoutBuf.slice(nlIdx + 1);
          if (!line) continue;

          let event: {
            type?: string;
            data?: {
              path?: { text?: string };
              line_number?: number;
              lines?: { text?: string };
            };
          };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type !== "match") continue;
          const data = event.data;
          if (!data) continue;
          const rawFile = data.path?.text;
          const lineNumber = data.line_number;
          const rawContent = data.lines?.text;
          // Non-UTF-8 paths/lines come back as `bytes` (base64) instead of
          // `text`. Skip those — they're rare in workspaces and the UI
          // can't render them sensibly.
          if (!rawFile || typeof lineNumber !== "number" || rawContent === undefined) {
            continue;
          }
          // ripgrep prefixes paths with the search root we passed (`./`).
          // Strip that to match the workspace-relative paths returned by
          // `searchFiles` (`git ls-files`).
          const file = rawFile.startsWith("./") ? rawFile.slice(2) : rawFile;
          const content = rawContent.endsWith("\n") ? rawContent.slice(0, -1) : rawContent;
          results.push({ file, line: lineNumber, content });

          if (results.length >= limit) {
            killed = true;
            child.kill("SIGTERM");
            finish(results);
            return;
          }
        }
      });

      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        stderrBuf += chunk;
      });

      child.on("error", (err) => {
        fail(err);
      });

      child.on("close", (code) => {
        if (settled) return;
        // ripgrep exit codes: 0 = matches found, 1 = no matches, 2 = error.
        // Both 0 and 1 are valid "no failure" outcomes for our purposes.
        if (code === 0 || code === 1 || killed) {
          finish(results);
        } else {
          fail(new Error(`ripgrep exited with code ${code}: ${stderrBuf.trim()}`));
        }
      });
    });
  }
}

export const searchService = new SearchService();
