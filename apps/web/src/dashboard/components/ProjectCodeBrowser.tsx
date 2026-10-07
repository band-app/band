import { Button, Input } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import { CodeMirrorViewer } from "./CodeMirrorViewer";
import { DiffFileContent } from "./DiffFileContent";

/**
 * The coordinator's code browser (plan step T.1b): one tab per project repo, with the Code view
 * (tree, file, search) and the Changes view of the repo's default-branch checkout in the project
 * folder. Every call goes through `projects.code*`, scoped to the project's repos.
 */

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function languageOf(path: string): string {
  const name = path.split("/").pop() || path;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return extensionToLanguage(ext) || filenameToLanguage(name) || "plaintext";
}

/** Splits a multi-file `git diff` into one entry per file. */
function splitDiff(diff: string): Array<{ file: string; hunks: string }> {
  const out: Array<{ file: string; hunks: string }> = [];
  for (const section of diff.split(/^(?=diff --git )/m)) {
    if (!section.startsWith("diff --git ")) continue;
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    out.push({ file: m?.[2] ?? "file", hunks: section });
  }
  return out;
}

function DiffView({ diff }: { diff: string }) {
  const files = splitDiff(diff);
  if (files.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="code-browser__diff-empty">
        No textual changes.
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid="code-browser__diff">
      {files.map((f) => (
        <div key={f.file} className="rounded-md border" data-file={f.file}>
          <div className="border-b px-2 py-1 text-xs font-medium">{f.file}</div>
          <DiffFileContent hunks={f.hunks} filename={f.file} viewMode="unified" />
        </div>
      ))}
    </div>
  );
}

function Err({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" data-testid="code-browser__error" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

export function ProjectCodeBrowser({
  project,
  repos,
  canEdit,
}: {
  project: string;
  repos: string[];
  canEdit: boolean;
}) {
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [tab, setTab] = useState<"code" | "changes">("code");
  const active = repos.includes(repo) ? repo : (repos[0] ?? "");
  if (repos.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="code-browser">
      <h3 className="text-sm font-medium">Code</h3>
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Repos">
        {repos.map((r) => (
          <Button
            key={r}
            size="sm"
            variant={r === active ? "default" : "outline"}
            data-testid="code-browser__repo"
            data-repo={r}
            data-active={r === active ? "true" : "false"}
            onClick={() => setRepo(r)}
          >
            {r}
          </Button>
        ))}
      </div>
      <div className="flex gap-1">
        {(["code", "changes"] as const).map((t) => (
          <Button
            key={t}
            size="sm"
            variant={t === tab ? "secondary" : "ghost"}
            data-testid={`code-browser__tab-${t}`}
            onClick={() => setTab(t)}
          >
            {t === "code" ? "Code" : "Changes"}
          </Button>
        ))}
      </div>
      {tab === "code" ? (
        <CodeTab key={`${active}:code`} project={project} repo={active} />
      ) : (
        <ChangesTab key={`${active}:changes`} project={project} repo={active} canEdit={canEdit} />
      )}
    </section>
  );
}

// ---- Code -------------------------------------------------------------------------

function Directory({
  project,
  repo,
  path,
  depth,
  onOpen,
  selected,
}: {
  project: string;
  repo: string;
  path: string;
  depth: number;
  onOpen: (path: string) => void;
  selected: string | null;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const listing = useQuery({
    queryKey: ["projects.codeRead", project, repo, path],
    queryFn: () => trpc.projects.codeRead.query({ project, repo, path }),
  });
  if (listing.error) return <Err message={errorText(listing.error)} />;
  const data = listing.data;
  if (!data || data.kind !== "dir") return null;
  return (
    <ul style={{ paddingLeft: depth === 0 ? 0 : 12 }} className="space-y-0.5">
      {data.entries.map((e) => {
        const child = path ? `${path}/${e.name}` : e.name;
        return (
          <li key={e.name}>
            <button
              type="button"
              className={`w-full truncate text-left text-xs hover:underline ${selected === child ? "font-semibold" : ""}`}
              data-testid={e.isDir ? "code-browser__dir" : "code-browser__file"}
              data-path={child}
              onClick={() =>
                e.isDir ? setOpen((o) => ({ ...o, [e.name]: !o[e.name] })) : onOpen(child)
              }
            >
              {e.isDir ? (open[e.name] ? "▾ " : "▸ ") : "  "}
              {e.name}
            </button>
            {e.isDir && open[e.name] ? (
              <Directory
                project={project}
                repo={repo}
                path={child}
                depth={depth + 1}
                onOpen={onOpen}
                selected={selected}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function CodeTab({ project, repo }: { project: string; repo: string }) {
  const [file, setFile] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const content = useQuery({
    queryKey: ["projects.codeRead", project, repo, "file", file],
    queryFn: () => trpc.projects.codeRead.query({ project, repo, path: file ?? "" }),
    enabled: file !== null,
    retry: false,
  });
  const search = useQuery({
    queryKey: ["projects.codeSearch", project, repo, submitted],
    queryFn: () => trpc.projects.codeSearch.query({ project, repo, query: submitted }),
    enabled: submitted !== "",
    retry: false,
  });
  return (
    <div className="space-y-2" data-testid="code-browser__code" data-repo={repo}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <Input
          value={query}
          placeholder="Search this repo"
          aria-label="Search this repo"
          data-testid="code-browser__search"
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button size="sm" type="submit" variant="outline" data-testid="code-browser__search-submit">
          Search
        </Button>
      </form>
      {submitted ? (
        <div data-testid="code-browser__results">
          <Err message={search.error ? errorText(search.error) : null} />
          {search.data?.length === 0 ? (
            <p className="text-xs text-muted-foreground">No matches.</p>
          ) : null}
          <ul className="space-y-0.5">
            {search.data?.map((m) => (
              <li key={`${m.path}:${m.line}`}>
                <button
                  type="button"
                  className="w-full truncate text-left text-xs hover:underline"
                  data-testid="code-browser__result"
                  data-path={m.path}
                  onClick={() => setFile(m.path)}
                >
                  {m.path}:{m.line} {m.text.trim()}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="grid gap-2 md:grid-cols-[16rem_1fr]">
        <div
          className="max-h-96 overflow-auto rounded-md border p-2"
          data-testid="code-browser__tree"
        >
          <Directory
            project={project}
            repo={repo}
            path=""
            depth={0}
            onOpen={setFile}
            selected={file}
          />
        </div>
        <div
          className="min-h-32 rounded-md border"
          data-testid="code-browser__viewer"
          data-path={file ?? ""}
        >
          {file === null ? (
            <p className="p-2 text-xs text-muted-foreground">Select a file.</p>
          ) : content.error ? (
            <div className="p-2">
              <Err message={errorText(content.error)} />
            </div>
          ) : content.data?.kind === "file" ? (
            <div className="max-h-96 overflow-auto">
              <div className="border-b px-2 py-1 text-xs font-medium">{file}</div>
              <CodeMirrorViewer
                key={file}
                content={content.data.content}
                language={languageOf(file)}
                filePath={file}
              />
              {content.data.truncated ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  Showing the first part of the file ({content.data.size} bytes).
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---- Changes ----------------------------------------------------------------------

interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

function CommitList({
  commits,
  testId,
  onPick,
  picked,
}: {
  commits: Commit[];
  testId: string;
  onPick?: (sha: string) => void;
  picked?: string | null;
}) {
  return (
    <ul className="space-y-0.5" data-testid={testId}>
      {commits.map((c) => (
        <li key={c.sha} className="text-xs" data-testid={`${testId}-item`} data-sha={c.sha}>
          {onPick ? (
            <button
              type="button"
              className={`text-left hover:underline ${picked === c.sha ? "font-semibold" : ""}`}
              onClick={() => onPick(picked === c.sha ? "" : c.sha)}
            >
              {c.sha.slice(0, 7)} {c.subject}
            </button>
          ) : (
            <span>
              {c.sha.slice(0, 7)} {c.subject}
            </span>
          )}{" "}
          <span className="text-muted-foreground">{c.author}</span>
        </li>
      ))}
    </ul>
  );
}

function ChangesTab({
  project,
  repo,
  canEdit,
}: {
  project: string;
  repo: string;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [work, setWork] = useState<string | null>(null);

  const statusKey = ["projects.codeStatus", project, repo];
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => trpc.projects.codeStatus.query({ project, repo }),
    refetchInterval: 4_000,
  });
  const diff = useQuery({
    queryKey: [
      "projects.codeDiff",
      project,
      repo,
      "working",
      status.data?.files.map((f) => f.path),
    ],
    queryFn: () => trpc.projects.codeDiff.query({ project, repo, target: { kind: "working" } }),
    enabled: (status.data?.files.length ?? 0) > 0,
  });
  const log = useQuery({
    queryKey: ["projects.codeLog", project, repo, status.data?.ahead, status.data?.behind],
    queryFn: () => trpc.projects.codeLog.query({ project, repo, n: 20 }),
  });
  const commitDiff = useQuery({
    queryKey: ["projects.codeDiff", project, repo, "commit", commitSha],
    queryFn: () =>
      trpc.projects.codeDiff.query({
        project,
        repo,
        target: { kind: "commit", sha: commitSha as string },
      }),
    enabled: !!commitSha,
  });
  const openWork = useQuery({
    queryKey: ["projects.codeOpenWork", project, repo],
    queryFn: () => trpc.projects.codeOpenWork.query({ project, repo }),
    refetchInterval: 10_000,
  });

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ["projects.codeStatus", project] });
      await queryClient.invalidateQueries({ queryKey: ["projects.codeDiff", project, repo] });
      await queryClient.invalidateQueries({ queryKey: ["projects.codeLog", project, repo] });
      await queryClient.invalidateQueries({ queryKey: ["projects.folder"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const s = status.data;
  if (status.error) return <Err message={errorText(status.error)} />;
  if (!s) return <p className="text-xs text-muted-foreground">Loading.</p>;
  const chosen = s.files.filter((f) => picked[f.path]).map((f) => f.path);

  return (
    <div className="space-y-3" data-testid="code-browser__changes" data-repo={repo}>
      <p className="text-xs text-muted-foreground" data-testid="code-browser__branch">
        {s.branch} tracks {s.upstream}: {s.ahead} ahead, {s.behind} behind
      </p>
      <Err message={error} />

      <div className="space-y-1" data-testid="code-browser__uncommitted">
        <h4 className="text-xs font-medium">Uncommitted ({s.files.length})</h4>
        {s.files.length === 0 ? (
          <p className="text-xs text-muted-foreground">No uncommitted changes.</p>
        ) : (
          <>
            <ul className="space-y-0.5">
              {s.files.map((f) => (
                <li key={f.path} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    aria-label={`Include ${f.path}`}
                    checked={!!picked[f.path]}
                    onChange={(e) => setPicked((p) => ({ ...p, [f.path]: e.target.checked }))}
                  />
                  <span
                    data-testid="code-browser__changed-file"
                    data-path={f.path}
                    data-status={f.status}
                  >
                    {f.status}: {f.path}
                  </span>
                </li>
              ))}
            </ul>
            {diff.data ? <DiffView diff={diff.data.diff} /> : null}
            {canEdit ? (
              <div className="flex gap-2">
                <Input
                  value={message}
                  placeholder={
                    chosen.length > 0
                      ? "Commit message (selected files)"
                      : "Commit message (all changes)"
                  }
                  aria-label="Commit message"
                  data-testid="code-browser__commit-message"
                  onChange={(e) => setMessage(e.target.value)}
                />
                <Button
                  size="sm"
                  disabled={busy || message.trim() === ""}
                  data-testid="code-browser__commit"
                  onClick={() =>
                    act(async () => {
                      await trpc.projects.codeCommit.mutate({
                        project,
                        repo,
                        message,
                        ...(chosen.length > 0 ? { paths: chosen } : {}),
                      });
                      setMessage("");
                      setPicked({});
                    })
                  }
                >
                  Commit
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="space-y-1" data-testid="code-browser__unpushed">
        <h4 className="text-xs font-medium">Unpushed commits ({s.ahead})</h4>
        {s.unpushed.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing to push.</p>
        ) : (
          <CommitList commits={s.unpushed} testId="code-browser__unpushed-list" />
        )}
        {canEdit && s.ahead > 0 && s.behind === 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="code-browser__push"
            onClick={() => act(() => trpc.projects.codePush.mutate({ project, repo }))}
          >
            Push
          </Button>
        ) : null}
      </div>

      <div className="space-y-1" data-testid="code-browser__behind">
        <h4 className="text-xs font-medium">Behind ({s.behind})</h4>
        {s.diverged ? (
          <p className="text-xs text-destructive" data-testid="code-browser__diverged">
            This checkout and {s.upstream} each have commits the other lacks. Resolve it in a
            terminal. Band does not merge, rebase or force push.
          </p>
        ) : null}
        {s.incoming.length > 0 ? (
          <CommitList commits={s.incoming} testId="code-browser__incoming-list" />
        ) : (
          <p className="text-xs text-muted-foreground">Up to date with the last fetch.</p>
        )}
        {canEdit && s.behind > 0 && s.ahead === 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="code-browser__pull"
            onClick={() => act(() => trpc.projects.codePull.mutate({ project, repo }))}
          >
            Pull (fast-forward)
          </Button>
        ) : null}
      </div>

      <div className="space-y-1" data-testid="code-browser__recent">
        <h4 className="text-xs font-medium">Recent commits</h4>
        <CommitList
          commits={log.data ?? []}
          testId="code-browser__log"
          picked={commitSha}
          onPick={(sha) => setCommitSha(sha || null)}
        />
        {commitSha && commitDiff.data ? <DiffView diff={commitDiff.data.diff} /> : null}
      </div>

      <div className="space-y-1" data-testid="code-browser__open-work">
        <h4 className="text-xs font-medium">Open work</h4>
        {openWork.data?.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No worktree of this project touches this repo.
          </p>
        ) : null}
        <ul className="space-y-0.5">
          {openWork.data?.map((w) => (
            <li
              key={w.worktreeId}
              className="text-xs"
              data-testid="code-browser__work"
              data-worktree={w.worktreeId}
            >
              <button
                type="button"
                className="text-left hover:underline"
                onClick={() => setWork(work === w.worktreeId ? null : w.worktreeId)}
              >
                {w.branch}
              </button>
              {w.pr ? <span className="text-muted-foreground"> PR #{w.pr.number}</span> : null}
              {w.ciState ? <span className="text-muted-foreground"> CI {w.ciState}</span> : null}
            </li>
          ))}
        </ul>
        {work ? <WorkDiff worktreeId={work} /> : null}
      </div>
    </div>
  );
}

/** A project worktree's changes against the default branch, from the worktree Changes calls. */
function WorkDiff({ worktreeId }: { worktreeId: string }) {
  const changes = useQuery({
    queryKey: ["projects.workChanges", worktreeId],
    queryFn: () => trpc.worktree.getChanges.query({ worktreeId }),
  });
  const files = changes.data?.branch ?? [];
  const mergeBase = changes.data?.mergeBase ?? undefined;
  const diffs = useQuery({
    queryKey: ["projects.workDiffs", worktreeId, mergeBase, files.map((f) => f.path)],
    enabled: !!mergeBase && files.length > 0,
    queryFn: async () =>
      Promise.all(
        files.map(async (f) => ({
          file: f.path,
          hunks: (
            await trpc.worktree.getFileDiff.query({
              worktreeId,
              filePath: f.path,
              section: "branch",
              mergeBase,
              oldPath: f.oldPath,
            })
          ).diff,
        })),
      ),
  });
  if (changes.error) return <Err message={errorText(changes.error)} />;
  return (
    <div className="space-y-2" data-testid="code-browser__work-diff" data-worktree={worktreeId}>
      {files.length === 0 && changes.data ? (
        <p className="text-xs text-muted-foreground">
          No changes against {changes.data.compareBranch}.
        </p>
      ) : null}
      {diffs.data?.map((d) => (
        <div key={d.file} className="rounded-md border" data-file={d.file}>
          <div className="border-b px-2 py-1 text-xs font-medium">{d.file}</div>
          <DiffFileContent hunks={d.hunks} filename={d.file} viewMode="unified" />
        </div>
      ))}
    </div>
  );
}
