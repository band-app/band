/**
 * The Changes view's file lists, grouped into sections the way orca's source
 * control panel groups them:
 *
 *   Conflicts · Changes · Staged Changes · Untracked Files · Committed on Branch
 *
 * Each section is collapsible, shows its file count, and is hidden while it
 * is empty. The uncommitted sections carry orca's header actions (discard
 * all, stage all, unstage all) and the same actions per file and folder on
 * hover. Every section has "View all", which opens its files in one diff tab.
 * "Committed on Branch" lists only what the branch's commits changed since it
 * forked from the compare branch; uncommitted work never shows up there.
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, Minus, Plus, Trash2, Undo2 } from "lucide-react";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import {
  type ChangeEntry,
  type ChangeSection,
  ChangesFileTree,
  type ChangesTreeAction,
  type WorkspaceChanges,
} from "@/dashboard";
import {
  CHANGE_SECTIONS,
  invalidateWorkspaceChanges,
  SECTION_LABELS,
} from "../hooks/useWorkspaceChanges";
import { trpc } from "../lib/trpc-client";

const COLLAPSED_KEY = "band:changes-collapsed-sections";

function readCollapsed(): Set<ChangeSection> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((s): s is ChangeSection => CHANGE_SECTIONS.includes(s)));
    }
  } catch {}
  return new Set();
}

function writeCollapsed(collapsed: Set<ChangeSection>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {}
}

type DiscardSection = "unstaged" | "staged" | "untracked";

/** A section header button: a row action applied to the whole section. */
interface HeaderAction {
  id: string;
  label: string;
  icon: React.FC<{ className?: string }>;
  run: () => void;
}

interface PendingDiscard {
  section: DiscardSection;
  entries: ChangeEntry[];
}

export interface ChangesSectionsProps {
  workspaceId: string;
  changes: WorkspaceChanges | undefined;
  onOpen: (section: ChangeSection, entry: ChangeEntry, pinned: boolean) => void;
  /** "View all": open every file of a section in one diff tab. Hidden when unset. */
  onViewAll?: (section: ChangeSection) => void;
  /** Offer stage / unstage / discard. The mobile sheet leaves them off. */
  editable?: boolean;
  activeFile?: string | null;
  workspacePath?: string;
}

export function ChangesSections({
  workspaceId,
  changes,
  onOpen,
  onViewAll,
  editable = false,
  activeFile,
  workspacePath,
}: ChangesSectionsProps) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState<Set<ChangeSection>>(() => readCollapsed());
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback((section: ChangeSection) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      writeCollapsed(next);
      return next;
    });
  }, []);

  const run = useCallback(
    async (label: string, op: () => Promise<unknown>) => {
      setError(null);
      try {
        await op();
      } catch (err) {
        setError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await invalidateWorkspaceChanges(queryClient, workspaceId);
      }
    },
    [queryClient, workspaceId],
  );

  const stage = useCallback(
    (entries: ChangeEntry[]) =>
      run("Stage", () =>
        trpc.workspace.stageFiles.mutate({ workspaceId, paths: entries.map((e) => e.path) }),
      ),
    [run, workspaceId],
  );

  const unstage = useCallback(
    (entries: ChangeEntry[]) =>
      run("Unstage", () =>
        trpc.workspace.unstageFiles.mutate({
          workspaceId,
          // A staged rename is two index entries; unstage both sides.
          paths: entries.flatMap((e) => (e.oldPath ? [e.path, e.oldPath] : [e.path])),
        }),
      ),
    [run, workspaceId],
  );

  const confirmDiscard = useCallback(async () => {
    if (!pendingDiscard) return;
    setDiscarding(true);
    const { section, entries } = pendingDiscard;
    await run("Discard", () =>
      trpc.workspace.discardChanges.mutate({
        workspaceId,
        section,
        paths: entries.flatMap((e) =>
          section === "staged" && e.oldPath ? [e.path, e.oldPath] : [e.path],
        ),
      }),
    );
    setDiscarding(false);
    setPendingDiscard(null);
  }, [pendingDiscard, run, workspaceId]);

  const actionsBySection = useMemo(() => {
    const discard = (section: DiscardSection): ChangesTreeAction => ({
      id: "discard",
      label: section === "untracked" ? "Delete untracked file" : "Discard changes",
      icon: section === "untracked" ? Trash2 : Undo2,
      destructive: true,
      run: (entries) => setPendingDiscard({ section, entries }),
    });
    const stageAction: ChangesTreeAction = { id: "stage", label: "Stage", icon: Plus, run: stage };
    const unstageAction: ChangesTreeAction = {
      id: "unstage",
      label: "Unstage",
      icon: Minus,
      run: unstage,
    };
    const none: ChangesTreeAction[] = [];
    return {
      // Staging a conflicted file marks it resolved (`git add`).
      conflicts: editable ? [{ ...stageAction, label: "Mark as resolved" }] : none,
      unstaged: editable ? [discard("unstaged"), stageAction] : none,
      staged: editable ? [discard("staged"), unstageAction] : none,
      untracked: editable ? [discard("untracked"), stageAction] : none,
      branch: none,
    } satisfies Record<ChangeSection, ChangesTreeAction[]>;
  }, [editable, stage, unstage]);

  const visible = CHANGE_SECTIONS.filter((s) => (changes?.[s].length ?? 0) > 0);

  return (
    <div data-testid="changes-sections">
      {error && (
        <p
          className="px-3 py-1.5 text-[11px] break-words text-destructive"
          data-testid="changes-sections__error"
        >
          {error}
        </p>
      )}
      {changes && visible.length === 0 && (
        <p
          className="px-3 py-2 text-xs text-muted-foreground"
          data-testid="changes-sections__empty"
        >
          No changes
        </p>
      )}
      {changes && changes.branch.length === 0 && changes.branchStatus !== "ready" && (
        <p
          className="px-3 py-1.5 text-[11px] text-muted-foreground"
          data-testid="changes-sections__branch-unavailable"
        >
          {branchUnavailableMessage(changes)}
        </p>
      )}
      {changes &&
        visible.map((section) => {
          const entries = changes[section];
          const isCollapsed = collapsed.has(section);
          const actions = actionsBySection[section];
          // The header runs each row action on every file of the section.
          const headerActions = actions.map(
            (action): HeaderAction => ({
              id: `${action.id}-all`,
              label: headerLabel(section, action.id),
              icon: action.icon,
              run: () => action.run(action.appliesTo ? entries.filter(action.appliesTo) : entries),
            }),
          );
          return (
            <section key={section} data-testid={`changes-section--${section}`}>
              <SectionHeader
                section={section}
                count={entries.length}
                countTitle={
                  section === "branch"
                    ? `${entries.length} file${entries.length === 1 ? "" : "s"} changed vs ${changes.compareBranch}`
                    : undefined
                }
                collapsed={isCollapsed}
                onToggle={() => toggle(section)}
                actions={headerActions}
                onViewAll={onViewAll ? () => onViewAll(section) : undefined}
              />
              {!isCollapsed && (
                <ChangesFileTree
                  entries={entries}
                  actions={actions}
                  onSelectFile={(entry) => onOpen(section, entry, false)}
                  onSelectFilePinned={(entry) => onOpen(section, entry, true)}
                  workspacePath={workspacePath}
                  activeFile={activeFile}
                />
              )}
            </section>
          );
        })}

      <Dialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => {
          if (!open && !discarding) setPendingDiscard(null);
        }}
      >
        <DialogContent className="sm:max-w-[425px]" data-testid="changes-sections__discard-dialog">
          <DialogHeader>
            <DialogTitle>
              {pendingDiscard?.section === "untracked" ? "Delete files" : "Discard changes"}
            </DialogTitle>
            <DialogDescription>
              {pendingDiscard && discardQuestion(pendingDiscard)}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-yellow-500" />
            <span>{pendingDiscard && discardWarning(pendingDiscard.section)}</span>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDiscard(null)} disabled={discarding}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDiscard()}
              disabled={discarding}
              data-testid="changes-sections__discard-confirm"
            >
              {pendingDiscard?.section === "untracked" ? "Delete" : "Discard"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SectionHeader({
  section,
  count,
  countTitle,
  collapsed,
  onToggle,
  actions,
  onViewAll,
}: {
  section: ChangeSection;
  count: number;
  countTitle?: string;
  collapsed: boolean;
  onToggle: () => void;
  actions: HeaderAction[];
  onViewAll?: () => void;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    // The icon actions appear on hover or keyboard focus, as in VS Code, so a
    // narrow panel keeps room for the label; devices without hover always
    // show them.
    <div className="group flex h-7 items-center gap-1 pr-2 pl-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        data-testid="changes-section__toggle"
        className="flex h-full min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
      >
        <Chevron className="size-3.5 shrink-0" />
        <span className="truncate">{SECTION_LABELS[section]}</span>
        <span
          className="text-[10px] font-medium tabular-nums"
          title={countTitle}
          data-testid="changes-section__count"
        >
          {count}
        </span>
      </button>
      {actions.length > 0 && (
        <div className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex [@media(hover:none)]:flex">
          {actions.map((action) => (
            <HeaderButton
              key={action.id}
              label={action.label}
              icon={action.icon}
              onClick={action.run}
              testid={`changes-section__action--${action.id}`}
            />
          ))}
        </div>
      )}
      {onViewAll && (
        <button
          type="button"
          onClick={onViewAll}
          data-testid="changes-section__view-all"
          className="shrink-0 rounded-sm px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          View all
        </button>
      )}
    </div>
  );
}

function HeaderButton({
  label,
  icon: Icon,
  onClick,
  testid,
}: {
  label: string;
  icon: React.FC<{ className?: string }>;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={testid}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function headerLabel(section: ChangeSection, actionId: string): string {
  switch (actionId) {
    case "discard":
      return section === "untracked" ? "Delete all untracked files" : "Discard all";
    case "stage":
      return section === "conflicts" ? "Mark all as resolved" : "Stage all";
    case "unstage":
      return "Unstage all";
    default:
      return actionId;
  }
}

function discardQuestion({ section, entries }: PendingDiscard): string {
  const what = entries.length === 1 ? entries[0].path : `${entries.length} files`;
  if (section === "untracked") return `Delete ${what}?`;
  if (section === "staged") return `Discard the staged changes to ${what}?`;
  return `Discard the changes to ${what}?`;
}

/** What a discard in `section` throws away; shared with the diff leaf's revert. */
export function discardWarning(section: DiscardSection): string {
  switch (section) {
    case "untracked":
      return "Untracked files are deleted from disk. This cannot be undone.";
    case "staged":
      return "The files go back to their last committed version, including any unstaged edits. Files added in the index are deleted. This cannot be undone.";
    case "unstaged":
      return "Unstaged edits are thrown away; staged changes are kept. This cannot be undone.";
  }
}

function branchUnavailableMessage(changes: WorkspaceChanges): string {
  switch (changes.branchStatus) {
    case "invalid-base":
      return `Can't compare with ${changes.compareBranch}: the branch doesn't exist.`;
    case "no-merge-base":
      return `${changes.headBranch} shares no history with ${changes.compareBranch}.`;
    case "unborn-head":
      return "No commits on this branch yet.";
    default:
      return "";
  }
}
