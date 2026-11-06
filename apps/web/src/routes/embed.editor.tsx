import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ExtensionEditor } from "../components/extensions/ExtensionEditor";
import { type ExtensionList, resolveEditor, useExtensions } from "../lib/extensions";
import { hubFetch } from "../lib/hub-config";

interface EmbedEditorSearch {
  worktreeId?: string;
  path?: string;
  editor?: string;
}

/**
 * `/embed/editor?worktreeId=<id>&path=<path>&editor=<extensionId/editorId>`: one extension editor
 * for one file, full screen, in the compact layout with a Save button. The iOS app loads it in a
 * web view. It signs in like the rest of the web app (the `band_token` cookie, set by a `?token=`
 * link), registers with the hub and reports selections through the same code as a normal tab.
 */
export const Route = createFileRoute("/embed/editor")({
  component: EmbedEditor,
  validateSearch: (search: Record<string, unknown>): EmbedEditorSearch => ({
    worktreeId: typeof search.worktreeId === "string" ? search.worktreeId : undefined,
    path: typeof search.path === "string" ? search.path : undefined,
    editor: typeof search.editor === "string" ? search.editor : undefined,
  }),
});

function EmbedMessage({ message, code }: { message: string; code: string }) {
  return (
    <div
      role="alert"
      data-testid="embed-editor__error"
      data-error={code}
      className="flex h-dvh items-center justify-center p-6 text-center text-sm text-destructive"
    >
      {message}
    </div>
  );
}

function fileRoute(worktreeId: string, path: string): string {
  return `/api/worktree-file/${encodeURIComponent(worktreeId)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/** Whether the file can be read: null while unknown, else the problem or "" for none. */
function useFileProblem(worktreeId: string | undefined, path: string | undefined) {
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!worktreeId || !path) return;
    let cancelled = false;
    hubFetch(fileRoute(worktreeId, path), { headers: { Range: "bytes=0-0" } })
      .then((res) => {
        if (cancelled) return;
        if (res.status === 404) setProblem(`${path} was not found in this worktree.`);
        else if (res.status === 401 || res.status === 403) setProblem("Sign in to Band first.");
        else if (!res.ok) setProblem(`Could not read ${path} (${res.status}).`);
        else setProblem("");
      })
      .catch(() => !cancelled && setProblem(`Could not reach the Band hub.`));
    return () => {
      cancelled = true;
    };
  }, [worktreeId, path]);
  return problem;
}

function EmbedEditor() {
  const { worktreeId, path, editor: ref } = Route.useSearch();
  const { list, loading } = useExtensions();
  const problem = useFileProblem(worktreeId, path);
  if (!worktreeId || !path || !ref) {
    return <EmbedMessage message="worktreeId, path and editor are required." code="bad-link" />;
  }
  if (loading || problem === null) return null;
  const resolved = resolveEditor(list as ExtensionList | null, path, ref);
  if (!resolved)
    return <EmbedMessage message={`The editor ${ref} is not installed.`} code="missing-editor" />;
  if (problem)
    return (
      <EmbedMessage
        message={problem}
        code={problem.startsWith("Sign in") ? "unauthorized" : "missing-file"}
      />
    );
  return (
    <div className="h-dvh w-screen bg-background" data-testid="embed-editor">
      <ExtensionEditor
        worktreeId={worktreeId}
        filePath={path}
        extensionId={resolved.extensionId}
        editor={resolved.editor}
        visible
        compact
      />
    </div>
  );
}
