import { matchesSelector } from "@band-app/plugin-api";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { toWorktreeId, useRepos } from "@/dashboard";
import { trpc } from "./trpc-client";

/** The language server that serves a file, as the worktree's worker reports it. */
export interface FileLanguageServer {
  /** `<extension id>/<server id>`, the `lang` of the `/lsp` socket. */
  key: string;
  /** The LSP languageId to open the file with. */
  languageId: string;
}

interface ReportedServer {
  key: string;
  languages: string[];
  files: string[];
  state: "ready" | "unavailable";
}

/** LSP languageIds by file extension. A server is offered only when it lists the id. */
const LANGUAGE_ID_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  py: "python",
  pyi: "python",
};

/** The ready server for a file, or null. Exported for the unit test. */
export function pickLanguageServer(
  servers: readonly ReportedServer[],
  filePath: string,
): FileLanguageServer | null {
  const name = filePath.split("/").pop() ?? filePath;
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined;
  const known = extension ? LANGUAGE_ID_BY_EXTENSION[extension] : undefined;
  for (const server of servers) {
    if (server.state !== "ready") continue;
    if (!server.files.some((glob) => matchesSelector(glob, name))) continue;
    const languageId =
      known && server.languages.includes(known) ? known : (server.languages[0] as string);
    return { key: server.key, languageId };
  }
  return null;
}

/**
 * The language server for a file of a worktree: the first ready server on the worktree's worker
 * whose `files` globs match. Null while the worker list loads and for a file no server claims.
 */
export function useLanguageServerFor(
  worktreeId: string,
  filePath: string,
  disabled: boolean,
): FileLanguageServer | null {
  const { repos } = useRepos();
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.workers.list.query()).hosts,
    enabled: !disabled,
  });
  const hostId = repos
    .flatMap((repo) =>
      repo.worktrees.map((wt) => ({ id: toWorktreeId(repo.name, wt.name, wt.hostId), wt })),
    )
    .find((entry) => entry.id === worktreeId)?.wt.hostId;
  const servers = hosts.data?.find((h) => h.id === (hostId ?? "local"))?.languageServers;
  return useMemo(
    () => (disabled || !servers ? null : pickLanguageServer(servers, filePath)),
    [disabled, servers, filePath],
  );
}
