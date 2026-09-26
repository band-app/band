/**
 * Header of the Changes tab: the workspace's current branch, and below it
 * the target the changes are compared against ("Uncommitted" or a branch).
 * Clicking the target opens a branch picker.
 *
 * Repos can have thousands of branches, so the picker never loads them all.
 * It sends the typed query to `workspace.listBranches`, which filters and
 * ranks local and remote branches on the server and returns the top
 * `BRANCH_LIMIT`. The "Default branch" button resets the target to the
 * project's default branch in one click.
 *
 * Picking a branch only changes the diff base (`useDiffTarget`, persisted per
 * workspace). Nothing is checked out.
 */

import {
  Button,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@band-app/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronDown, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { type DiffMode, useAdapter } from "@/dashboard";

/** cmdk item value of the "Uncommitted" entry; branch items use their name. */
const UNCOMMITTED_VALUE = "__uncommitted__";
const BRANCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 150;

export interface DiffTargetHeaderProps {
  workspaceId: string;
  /** Current branch of the worktree; undefined until the first summary loads. */
  headBranch: string | undefined;
  /** The project's default branch; undefined until the first summary loads. */
  defaultBranch: string | undefined;
  diffMode: DiffMode;
  compareBranch: string | null;
  onSelectUncommitted: () => void;
  onSelectBranch: (branch: string) => void;
}

export function DiffTargetHeader({
  workspaceId,
  headBranch,
  defaultBranch,
  diffMode,
  compareBranch,
  onSelectUncommitted,
  onSelectBranch,
}: DiffTargetHeaderProps) {
  const adapter = useAdapter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // The option the keyboard cursor is on (cmdk's `value`).
  const [activeValue, setActiveValue] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Start every open from an empty search.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
    }
  }, [open]);

  const branchesQuery = useQuery({
    queryKey: ["diffTargetBranches", workspaceId, debouncedQuery],
    queryFn: () =>
      adapter.listWorkspaceBranches?.(workspaceId, {
        query: debouncedQuery || undefined,
        limit: BRANCH_LIMIT,
      }) ?? null,
    enabled: open && !!adapter.listWorkspaceBranches,
    // Keep the previous matches on screen while the next query runs, so the
    // list doesn't blank out on every keystroke.
    placeholderData: keepPreviousData,
  });

  const branches = branchesQuery.data?.branches ?? [];
  const targetBranch = diffMode === "branch" ? (compareBranch ?? defaultBranch) : undefined;
  const selectedValue = targetBranch ?? UNCOMMITTED_VALUE;
  // "Uncommitted" is a mode, not a branch; offer it only when not searching.
  const showUncommitted = query.trim() === "";

  // Open with the cursor on the current target.
  useEffect(() => {
    if (open) setActiveValue(selectedValue);
  }, [open, selectedValue]);

  // True while the list still shows the matches of an earlier query.
  const pending = query.trim() !== debouncedQuery || branchesQuery.isPlaceholderData;

  // Results arrive after cmdk has reacted to the typed text, so move the
  // cursor here: to the best match of a search, or to the first option when
  // the one under the cursor is gone. Without this, Enter would pick nothing.
  // While a search is pending the cursor stays off the stale matches, so an
  // early Enter can't pick a branch that doesn't match the typed text.
  const results = branchesQuery.data;
  useEffect(() => {
    if (pending && !showUncommitted) {
      setActiveValue("");
      return;
    }
    if (!results) return;
    const values = showUncommitted ? [UNCOMMITTED_VALUE, ...results.branches] : results.branches;
    setActiveValue((current) =>
      !showUncommitted || !values.includes(current) ? (values[0] ?? "") : current,
    );
  }, [results, showUncommitted, pending]);

  const pick = (value: string) => {
    if (value === UNCOMMITTED_VALUE) onSelectUncommitted();
    else onSelectBranch(value);
    setOpen(false);
  };

  return (
    <div
      className="shrink-0 border-b border-border px-2 py-1.5 text-xs"
      data-testid="right-sidepanel__diff-target"
    >
      <div
        className="flex h-5 min-w-0 items-center gap-1.5 px-1.5 font-medium text-foreground"
        title={headBranch}
      >
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate" data-testid="right-sidepanel__head-branch">
          {headBranch ?? ""}
        </span>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="right-sidepanel__diff-target-select"
            title={targetBranch ?? "Uncommitted"}
            className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowRight className="size-3.5 shrink-0" />
            <span className="truncate">{targetBranch ?? "Uncommitted"}</span>
            <ChevronDown className="ml-auto size-3.5 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-80 p-0"
          data-testid="right-sidepanel__diff-target-picker"
        >
          <Command shouldFilter={false} value={activeValue} onValueChange={setActiveValue}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search branches"
              data-testid="right-sidepanel__diff-target-search"
            />
            {defaultBranch && (
              <div className="border-b border-border p-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-full justify-start gap-2 px-2 text-xs"
                  title={defaultBranch}
                  data-testid="right-sidepanel__diff-target-default"
                  onClick={() => pick(defaultBranch)}
                >
                  <GitBranch className="size-3.5" />
                  Default branch
                  <span className="ml-auto truncate text-muted-foreground">{defaultBranch}</span>
                </Button>
              </div>
            )}
            <CommandList data-testid="right-sidepanel__diff-target-list">
              {!branchesQuery.isFetching && (
                <CommandEmpty
                  className="py-4 text-center text-xs text-muted-foreground"
                  data-testid="right-sidepanel__diff-target-empty"
                >
                  No matching branches
                </CommandEmpty>
              )}
              <div className="p-1">
                {showUncommitted && (
                  <CommandItem
                    value={UNCOMMITTED_VALUE}
                    onSelect={pick}
                    data-testid="right-sidepanel__diff-target-option-uncommitted"
                    className="text-xs"
                  >
                    <CheckMark visible={selectedValue === UNCOMMITTED_VALUE} />
                    Uncommitted
                  </CommandItem>
                )}
                {branches.map((branch) => (
                  <CommandItem
                    key={branch}
                    value={branch}
                    onSelect={pick}
                    data-testid="right-sidepanel__diff-target-option"
                    className="text-xs"
                  >
                    <CheckMark visible={selectedValue === branch} />
                    <span className="truncate">{branch}</span>
                  </CommandItem>
                ))}
              </div>
              {branchesQuery.data?.truncated && (
                <p
                  className="px-3 pb-2 text-[11px] text-muted-foreground"
                  data-testid="right-sidepanel__diff-target-truncated"
                >
                  Showing the first {BRANCH_LIMIT} matches. Type to narrow the list.
                </p>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function CheckMark({ visible }: { visible: boolean }) {
  return <Check className={visible ? "size-3.5" : "size-3.5 invisible"} />;
}
