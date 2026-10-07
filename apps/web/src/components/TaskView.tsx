import { Button } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DiffFileContent } from "@/dashboard";
import { trpc } from "../lib/trpc-client";
import { ChatPane, useChatPaneState } from "./ChatPane";
import { TerminalPanel } from "./TerminalPanel";

type Task = Awaited<ReturnType<typeof trpc.projectTasks.get.query>>["task"];
type Member = Task["members"][number];

const POLL_MS = 3000;
const TASK_FOLDER = "";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One task of a project: its header, its chat, a section per member repo (Changes against the
 * default branch, the PR and its checks), Add repo and Remove repo, and terminals that open in the
 * task folder with a member picker. Everything comes from `projectTasks.*` and the worktree calls
 * that member worktrees already have.
 */
export function TaskView({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const task = useQuery({
    queryKey: ["projectTasks.get", taskId],
    queryFn: async () => (await trpc.projectTasks.get.query({ task: taskId })).task,
    refetchInterval: POLL_MS,
  });
  const data = task.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["projectTasks.get", taskId] });

  if (task.error && !data) {
    return (
      <div className="p-6 text-sm text-destructive" role="alert" data-testid="task-view__error">
        {errorText(task.error)}
      </div>
    );
  }
  if (!data) {
    return <div className="p-6 text-sm text-muted-foreground">Loading task…</div>;
  }
  return (
    <div
      className="h-full overflow-y-auto"
      data-testid="task-view"
      data-task={data.name}
      data-task-id={data.id}
    >
      <div className="mx-auto max-w-5xl space-y-6 p-4 pt-12">
        <Header task={data} />
        <ChatSection task={data} />
        <section className="space-y-3" data-testid="task-view__members">
          <h2 className="text-sm font-medium">Repos</h2>
          {data.members.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="task-view__no-members">
              No repos yet. Add one below, or the agent adds them from the brief.
            </p>
          ) : null}
          {data.members.map((m) => (
            <MemberSection key={m.repo} task={data} member={m} onChanged={refresh} />
          ))}
          <AddRepo task={data} onChanged={refresh} />
        </section>
        <TerminalSection task={data} />
      </div>
    </div>
  );
}

function Header({ task }: { task: Task }) {
  return (
    <header className="space-y-1" data-testid="task-view__header">
      <h1 className="text-lg font-semibold" data-testid="task-view__name">
        {task.name}
      </h1>
      <p className="text-xs text-muted-foreground">
        {task.project} · branch <span data-testid="task-view__branch">{task.branch}</span> · host{" "}
        <span data-testid="task-view__host">{task.hostId ?? "none"}</span> · status{" "}
        <span data-testid="task-view__status">{task.status}</span>
      </p>
      <p className="font-mono text-xs text-muted-foreground" data-testid="task-view__folder">
        {task.folder}
      </p>
    </header>
  );
}

function ChatSection({ task }: { task: Task }) {
  const chatId = task.chatIds[0];
  if (!chatId) {
    return (
      <section data-testid="task-view__chat" className="text-xs text-muted-foreground">
        This task has no chat.
      </section>
    );
  }
  return (
    <section className="h-[28rem] overflow-hidden rounded-md border" data-testid="task-view__chat">
      <TaskChat taskId={task.id} chatId={chatId} />
    </section>
  );
}

/** A task chat is keyed by `task:<id>`. A chat of a member worktree (an old one-member task) by its worktree. */
function TaskChat({ taskId, chatId }: { taskId: string; chatId: string }) {
  const chat = useQuery({
    queryKey: ["chats.get", chatId, "scope"],
    queryFn: async () => (await trpc.chats.get.query({ chatId })).chat,
  });
  if (!chat.data) return null;
  const scope = chat.data.worktreeId ?? `task:${taskId}`;
  return <ChatScope scope={scope} chatId={chatId} />;
}

function ChatScope({ scope, chatId }: { scope: string; chatId: string }) {
  const state = useChatPaneState(scope, chatId);
  return <ChatPane worktreeId={scope} chatId={chatId} visible wsActive state={state} />;
}

function MemberSection({
  task,
  member,
  onChanged,
}: {
  task: Task;
  member: Member;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.projectTasks.removeRepo.mutate({ task: task.id, repo: member.repo });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="space-y-2 rounded-md border p-3"
      data-testid="task-view__member"
      data-repo={member.repo}
      data-worktree={member.worktreeId ?? ""}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium" data-testid="task-member__repo">
            {member.repo}
            {member.role ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">{member.role}</span>
            ) : null}
          </h3>
          <p className="font-mono text-xs text-muted-foreground" data-testid="task-member__path">
            {member.path}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid="task-member__remove"
          onClick={remove}
        >
          Remove repo
        </Button>
      </div>
      {error ? (
        <p role="alert" data-testid="task-member__error" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {member.worktreeId ? <MemberReview worktreeId={member.worktreeId} /> : null}
      {member.worktreeId ? <MemberChanges worktreeId={member.worktreeId} /> : null}
    </div>
  );
}

function MemberReview({ worktreeId }: { worktreeId: string }) {
  const review = useQuery({
    queryKey: ["task.review", worktreeId],
    queryFn: () => trpc.reviews.forWorktree.query({ worktreeId }),
    refetchInterval: 15_000,
  });
  const r = review.data;
  if (!r) return null;
  if (r.status !== "ok") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="task-member__review-unavailable">
        {r.message}
      </p>
    );
  }
  return (
    <div className="space-y-1" data-testid="task-member__review">
      {r.review ? (
        <a
          href={r.review.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm underline"
          data-testid="task-member__pr"
          data-state={r.review.state}
        >
          #{r.review.number} {r.review.title}
        </a>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="task-member__no-pr">
          No pull request yet.
        </p>
      )}
      <div data-testid="task-member__ci" data-state={r.checks.state}>
        <span className="text-xs text-muted-foreground">CI: {r.checks.state}</span>
        <ul className="mt-1 space-y-0.5">
          {r.checks.checks.map((c) => (
            <li
              key={c.id}
              className="text-xs"
              data-testid="task-member__check"
              data-state={c.state}
            >
              {c.name}: {c.state}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MemberChanges({ worktreeId }: { worktreeId: string }) {
  const changes = useQuery({
    queryKey: ["task.changes", worktreeId],
    queryFn: () => trpc.worktree.getChanges.query({ worktreeId }),
    refetchInterval: POLL_MS,
  });
  const files = changes.data?.branch ?? [];
  const mergeBase = changes.data?.mergeBase ?? undefined;
  const diffs = useQuery({
    queryKey: ["task.diffs", worktreeId, mergeBase, JSON.stringify(files)],
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
  const uncommitted = [
    ...(changes.data?.staged ?? []),
    ...(changes.data?.unstaged ?? []),
    ...(changes.data?.untracked ?? []),
  ];
  return (
    <div className="space-y-2" data-testid="task-member__changes">
      <h4 className="text-xs font-medium text-muted-foreground">
        Changes against {changes.data?.compareBranch ?? "the default branch"}
      </h4>
      {changes.error ? (
        <p className="text-xs text-destructive">{errorText(changes.error)}</p>
      ) : null}
      {files.length === 0 && changes.data ? (
        <p className="text-xs text-muted-foreground" data-testid="task-member__no-changes">
          No commits yet.
        </p>
      ) : null}
      {diffs.data?.map((d) => (
        <div
          key={d.file}
          className="rounded-md border"
          data-testid="task-member__diff"
          data-file={d.file}
        >
          <div className="border-b px-2 py-1 text-xs font-medium">{d.file}</div>
          <DiffFileContent hunks={d.hunks} filename={d.file} viewMode="unified" />
        </div>
      ))}
      {uncommitted.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="task-member__uncommitted">
          Uncommitted: {uncommitted.map((f) => f.path).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function AddRepo({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const project = useQuery({
    queryKey: ["projects.get", task.projectId],
    queryFn: async () => (await trpc.projects.get.query({ project: task.projectId })).project,
  });
  const taken = new Set(task.members.map((m) => m.repo));
  const options = (project.data?.repos ?? []).filter((r) => !taken.has(r.repo));
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = options.some((o) => o.repo === repo) ? repo : (options[0]?.repo ?? "");
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.projectTasks.addRepo.mutate({ task: task.id, repo: chosen });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="task-view__add-repo">
      <select
        aria-label="Repo to add"
        data-testid="task-view__add-repo-select"
        className="h-8 rounded-md border bg-background px-2 text-sm"
        value={chosen}
        disabled={options.length === 0}
        onChange={(e) => setRepo(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.repo} value={o.repo}>
            {o.repo}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || chosen === ""}
        data-testid="task-view__add-repo-button"
        onClick={add}
      >
        Add repo
      </Button>
      {error ? (
        <p
          role="alert"
          data-testid="task-view__add-repo-error"
          className="text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function TerminalSection({ task }: { task: Task }) {
  const [where, setWhere] = useState(TASK_FOLDER);
  const [terminal, setTerminal] = useState<{
    worktreeId: string;
    terminalId: string;
    cwd: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      // Close the previous shell, since the pane drops it and nothing else would end it.
      if (terminal)
        await trpc.terminal.kill.mutate({ terminalId: terminal.terminalId }).catch(() => {});
      const opened = await trpc.projectTasks.openTerminal.mutate({
        task: task.id,
        ...(where !== TASK_FOLDER ? { repo: where } : {}),
      });
      setTerminal({
        worktreeId: opened.worktreeId,
        terminalId: opened.terminalId,
        cwd: opened.cwd,
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-2" data-testid="task-view__terminals">
      <h2 className="text-sm font-medium">Terminal</h2>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Terminal directory"
          data-testid="task-view__terminal-member"
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={where}
          onChange={(e) => setWhere(e.target.value)}
        >
          <option value={TASK_FOLDER}>Task folder</option>
          {task.members.map((m) => (
            <option key={m.repo} value={m.repo}>
              {m.repo}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid="task-view__terminal-open"
          onClick={open}
        >
          Open terminal
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          data-testid="task-view__terminal-error"
          className="text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      {terminal ? (
        <div
          className="h-64 rounded-md border"
          data-testid="task-view__terminal"
          data-cwd={terminal.cwd}
          data-terminal-id={terminal.terminalId}
        >
          <TerminalPanel
            worktreeId={terminal.worktreeId}
            terminalId={terminal.terminalId}
            visible
            autoFocus
          />
        </div>
      ) : null}
    </section>
  );
}
