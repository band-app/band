import { Button, Input } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { ContextMarkdown } from "./ContextMarkdown";

type ContextList = Awaited<ReturnType<typeof trpc.context.list.query>>;
type Tree = Awaited<ReturnType<typeof trpc.context.tree.query>>;
type FileContent = Awaited<ReturnType<typeof trpc.context.file.query>>;
type Commit = Awaited<ReturnType<typeof trpc.context.log.query>>["commits"][number];

const CONTEXTS_KEY = ["context.list"] as const;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
const formatTime = (at: number) => new Date(at).toLocaleString();

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" data-testid="context-browser__error" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

/** One line of a unified diff, colored by its first character. */
function DiffView({ diff }: { diff: string }) {
  return (
    <pre
      data-testid="context-browser__diff"
      className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-2 text-xs"
    >
      {diff.split("\n").map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond their position
          key={i}
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "text-green-600 dark:text-green-400"
              : line.startsWith("-") && !line.startsWith("---")
                ? "text-red-600 dark:text-red-400"
                : line.startsWith("@@")
                  ? "text-muted-foreground"
                  : undefined
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function HistoryPanel({ context, path }: { context: string; path: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const log = useQuery({
    queryKey: ["context.log", context, path],
    queryFn: () => trpc.context.log.query({ name: context, path }),
  });
  const diff = useQuery({
    queryKey: ["context.diff", context, open, path],
    queryFn: () => trpc.context.diff.query({ name: context, sha: open ?? "", path }),
    enabled: open !== null,
  });
  const commits: Commit[] = log.data?.commits ?? [];
  return (
    <div className="space-y-2" data-testid="context-browser__history">
      {commits.length === 0 && !log.isLoading ? (
        <p className="text-xs text-muted-foreground">No history for this file.</p>
      ) : null}
      <ul className="space-y-1">
        {commits.map((c) => (
          <li key={c.sha}>
            <button
              type="button"
              data-testid="context-browser__commit"
              aria-pressed={open === c.sha}
              onClick={() => setOpen(open === c.sha ? null : c.sha)}
              className="flex w-full flex-col rounded-md px-2 py-1 text-left text-xs hover:bg-muted aria-pressed:bg-muted"
            >
              <span className="font-medium">{c.subject}</span>
              <span className="text-muted-foreground">
                {c.author} · {formatTime(c.at)} · {c.sha.slice(0, 7)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && diff.data ? (
        <>
          <DiffView diff={diff.data.diff} />
          {diff.data.truncated ? (
            <p className="text-xs text-muted-foreground">The diff is cut off at 200 KB.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function FilePane({
  context,
  path,
  conflictOf,
  onChanged,
  onResolved,
}: {
  context: string;
  path: string;
  conflictOf: string | null;
  onChanged: () => void;
  onResolved: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const file = useQuery<FileContent>({
    queryKey: ["context.file", context, path],
    queryFn: () => trpc.context.file.query({ name: context, path }),
  });
  const [mode, setMode] = useState<"view" | "edit" | "history">("view");
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A different file starts in view mode with no half-typed edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the file changes
  useEffect(() => {
    setMode("view");
    setError(null);
    setMessage("");
  }, [context, path]);

  const data = file.data;
  const startEdit = () => {
    if (!data || data.binary) return;
    setDraft(data.content);
    setMessage(`Update ${path}`);
    setError(null);
    setMode("edit");
  };

  const save = async () => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      await trpc.context.write.mutate({
        name: context,
        path,
        content: draft,
        message,
        base: data.commit,
      });
      await queryClient.invalidateQueries({ queryKey: ["context.file", context, path] });
      await queryClient.invalidateQueries({ queryKey: ["context.log", context] });
      onChanged();
      setMode("view");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (keep: "original" | "conflict") => {
    setBusy(true);
    setError(null);
    try {
      const result = await trpc.context.resolveConflict.mutate({ name: context, path, keep });
      onChanged();
      onResolved(result.path);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0 flex-1 space-y-3" data-testid="context-browser__file">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          className="min-w-0 flex-1 truncate text-sm font-medium"
          data-testid="context-browser__file-path"
        >
          {path}
        </h3>
        {(["view", "edit", "history"] as const).map((m) => (
          <Button
            key={m}
            size="sm"
            variant={mode === m ? "default" : "outline"}
            data-testid={`context-browser__mode-${m}`}
            disabled={m === "edit" && (!data || data.binary)}
            onClick={() => (m === "edit" ? startEdit() : setMode(m))}
          >
            {m === "view" ? "View" : m === "edit" ? "Edit" : "History"}
          </Button>
        ))}
      </div>

      {conflictOf ? (
        <div
          data-testid="context-browser__conflict-banner"
          className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs"
        >
          <p>
            This is a conflict copy of <code>{conflictOf}</code>. Two writers changed the file at
            the same time. Keep one version and the other is deleted.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              data-testid="context-browser__keep-conflict"
              onClick={() => resolve("conflict")}
            >
              Keep this version
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              data-testid="context-browser__keep-original"
              onClick={() => resolve("original")}
            >
              Keep the original
            </Button>
          </div>
        </div>
      ) : null}

      <ErrorLine message={error ?? (file.error ? errorText(file.error) : null)} />

      {mode === "history" ? <HistoryPanel context={context} path={path} /> : null}

      {mode === "view" && data ? (
        data.binary ? (
          <p className="text-xs text-muted-foreground">
            This file is binary or too large to show ({data.size} bytes).
          </p>
        ) : isMarkdown(path) ? (
          <div data-testid="context-browser__rendered">
            <ContextMarkdown source={data.content} />
          </div>
        ) : (
          <pre
            data-testid="context-browser__raw"
            className="max-h-[32rem] overflow-auto rounded-md border bg-muted/30 p-2 text-xs"
          >
            {data.content}
          </pre>
        )
      ) : null}

      {mode === "edit" ? (
        <div className="space-y-2">
          <textarea
            aria-label="File content"
            data-testid="context-browser__editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-80 w-full rounded-md border bg-background p-2 font-mono text-xs"
          />
          <div className="flex gap-2">
            <Input
              aria-label="Commit message"
              data-testid="context-browser__message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
            />
            <Button
              disabled={busy || message.trim() === ""}
              data-testid="context-browser__save"
              onClick={save}
            >
              Save
            </Button>
            <Button variant="outline" onClick={() => setMode("view")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TreeList({
  tree,
  selected,
  onSelect,
}: {
  tree: Tree | undefined;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const entries = tree?.entries.filter((e) => !e.path.endsWith(".gitkeep")) ?? [];
  const shown = new Set<string>();
  const rows: Array<
    | { kind: "dir"; path: string; name: string; depth: number }
    | { kind: "file"; path: string; name: string; depth: number; conflict: boolean }
  > = [];
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join("/");
      if (!shown.has(dir)) {
        shown.add(dir);
        rows.push({ kind: "dir", path: dir, name: parts[i] ?? dir, depth: i });
      }
    }
    rows.push({
      kind: "file",
      path: entry.path,
      name: parts[parts.length - 1] ?? entry.path,
      depth: parts.length - 1,
      conflict: entry.conflictOf !== null,
    });
  }
  return (
    <ul className="space-y-0.5" data-testid="context-browser__tree">
      {rows.map((row) =>
        row.kind === "dir" ? (
          <li
            key={`d:${row.path}`}
            style={{ paddingLeft: row.depth * 12 + 8 }}
            className="py-0.5 text-xs font-medium text-muted-foreground"
          >
            {row.name}/
          </li>
        ) : (
          <li key={row.path}>
            <button
              type="button"
              data-testid="context-browser__tree-file"
              data-path={row.path}
              data-conflict={row.conflict}
              aria-current={selected === row.path}
              onClick={() => onSelect(row.path)}
              style={{ paddingLeft: row.depth * 12 + 8 }}
              className={`flex w-full items-center gap-2 rounded-md py-0.5 pr-2 text-left text-xs hover:bg-muted aria-[current=true]:bg-muted ${row.conflict ? "text-amber-600 dark:text-amber-400" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {row.conflict ? (
                <span className="rounded bg-amber-500/20 px-1 text-[10px] uppercase">conflict</span>
              ) : null}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

function RemoteRow({
  context,
  remoteUrl,
  syncError,
  onChanged,
}: {
  context: string;
  remoteUrl: string | null;
  syncError: string | null;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (remote: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await trpc.context.linkRemote.mutate({ name: context, remoteUrl: remote });
      setUrl("");
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="context-browser__remote">
      {remoteUrl ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            Linked to <code data-testid="context-browser__remote-url">{remoteUrl}</code>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="context-browser__unlink"
            onClick={() => run(null)}
          >
            Unlink
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            aria-label="Remote URL"
            data-testid="context-browser__remote-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/you/context.git"
          />
          <Button
            size="sm"
            disabled={busy || url.trim() === ""}
            data-testid="context-browser__link"
            onClick={() => run(url.trim())}
          >
            Link remote
          </Button>
        </div>
      )}
      <ErrorLine message={error} />
      {syncError ? (
        <p
          className="text-xs text-amber-600 dark:text-amber-400"
          data-testid="context-browser__sync-error"
        >
          Sync problem: {syncError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Settings > Context (plan step 5.5): browse the user context and each project's context the hub
 * holds as git repos. A markdown file renders with its `band://media` images and videos, can be
 * edited and saved as one commit, and has a history with diffs. Conflict copies are marked and
 * resolved by keeping one version. The feed lists the newest learnings and handoffs, and a context
 * can be linked to a remote repo. Changes apply at once and are not part of the dialog's Save.
 */
export function ContextSettings() {
  const queryClient = useQueryClient();
  const contexts = useQuery<ContextList>({
    queryKey: CONTEXTS_KEY,
    queryFn: () => trpc.context.list.query(),
  });
  const list = contexts.data?.contexts ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const active = list.find((c) => c.name === chosen) ?? list[0] ?? null;
  const name = active?.name ?? "";

  const tree = useQuery<Tree>({
    queryKey: ["context.tree", name],
    queryFn: () => trpc.context.tree.query({ name }),
    enabled: name !== "",
  });
  const recent = useQuery({
    queryKey: ["context.recent", name],
    queryFn: () => trpc.context.recent.query({ name }),
    enabled: name !== "",
  });
  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["context.tree", name] });
    queryClient.invalidateQueries({ queryKey: ["context.recent", name] });
    queryClient.invalidateQueries({ queryKey: CONTEXTS_KEY });
  };
  const conflictOf = tree.data?.entries.find((e) => e.path === path)?.conflictOf ?? null;
  const conflictCount = tree.data?.entries.filter((e) => e.conflictOf).length ?? 0;

  if (contexts.isLoading) return <p className="text-xs text-muted-foreground">Loading</p>;
  if (contexts.error) return <ErrorLine message={errorText(contexts.error)} />;
  if (!active) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="context-browser__empty">
        There are no contexts yet. Create one with <code>band context create user</code>.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="context-browser">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Contexts">
        {list.map((c) => (
          <Button
            key={c.name}
            size="sm"
            role="tab"
            aria-selected={c.name === active.name}
            variant={c.name === active.name ? "default" : "outline"}
            data-testid="context-browser__context"
            data-name={c.name}
            onClick={() => {
              setChosen(c.name);
              setPath(null);
            }}
          >
            {c.kind === "user" ? "User" : c.name}
          </Button>
        ))}
        {conflictCount > 0 ? (
          <span
            data-testid="context-browser__conflict-count"
            data-count={conflictCount}
            className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300"
          >
            {conflictCount} {conflictCount === 1 ? "conflict" : "conflicts"}
          </span>
        ) : null}
      </div>

      <RemoteRow
        context={active.name}
        remoteUrl={active.remoteUrl}
        syncError={active.syncError}
        onChanged={refreshAll}
      />

      <div className="flex flex-col gap-4 md:flex-row">
        <div className="w-full shrink-0 space-y-4 md:w-60">
          <TreeList tree={tree.data} selected={path} onSelect={setPath} />
          <div data-testid="context-browser__recent" className="space-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">
              Recent learnings and handoffs
            </h4>
            {recent.data?.entries.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing yet.</p>
            ) : null}
            <ul className="space-y-0.5">
              {recent.data?.entries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    data-testid="context-browser__recent-entry"
                    data-kind={e.kind}
                    onClick={() => setPath(e.path)}
                    className="flex w-full flex-col rounded-md px-2 py-1 text-left text-xs hover:bg-muted"
                  >
                    <span className="truncate">{e.path}</span>
                    <span className="text-muted-foreground">{formatTime(e.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        {path ? (
          <FilePane
            context={active.name}
            path={path}
            conflictOf={conflictOf}
            onChanged={refreshAll}
            onResolved={setPath}
          />
        ) : (
          <p className="text-xs text-muted-foreground">Pick a file to read it.</p>
        )}
      </div>
    </div>
  );
}
