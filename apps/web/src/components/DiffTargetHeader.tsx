/**
 * Header of the Changes tab: the worktree's current branch, and below it
 * the branch the "Committed on Branch" section compares against. Clicking
 * the target opens a branch picker. Uncommitted work has its own sections
 * (Changes, Staged Changes, Untracked Files), so it isn't a target here.
 *
 * Repos can have thousands of branches, so the picker never loads them all.
 * It sends the typed query to `worktree.listBranches`, which filters and
 * ranks local and remote branches on the server and returns the top
 * `BRANCH_LIMIT`. The "Default branch" button resets the target to the
 * repo's default branch in one click.
 *
 * Picking a branch only changes the compare base (`useDiffTarget`, persisted
 * per worktree). Nothing is checked out.
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
import { useAdapter } from "@/dashboard";

const BRANCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 150;

export interface DiffTargetHeaderProps {
  worktreeId: string;
  /** Current branch of the worktree; undefined until the first summary loads. */
  headBranch: string | undefined;
  /** The repo's default branch; undefined until the first summary loads. */
  defaultBranch: string | undefined;
  /** The picked compare branch; null means the default branch. */
  compareBranch: string | null;
  onSelectBranch: (branch: string) => void;
}

export function DiffTargetHeader({
  worktreeId,
  headBranch,
  defaultBranch,
  compareBranch,
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
    queryKey: ["diffTargetBranches", worktreeId, debouncedQuery],
    queryFn: () =>
      adapter.listWorktreeBranches?.(worktreeId, {
        query: debouncedQuery || undefined,
        limit: BRANCH_LIMIT,
      }) ?? null,
    enabled: open && !!adapter.listWorktreeBranches,
    // Keep the previous matches on screen while the next query runs, so the
    // list doesn't blank out on every keystroke.
    placeholderData: keepPreviousData,
  });

  const branches = branchesQuery.data?.branches ?? [];
  const targetBranch = compareBranch ?? defaultBranch;
  const selectedValue = targetBranch ?? "";
  const searching = query.trim() !== "";

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
    if (pending && searching) {
      setActiveValue("");
      return;
    }
    if (!results) return;
    const values = results.branches;
    setActiveValue((current) =>
      searching || !values.includes(current) ? (values[0] ?? "") : current,
    );
  }, [results, searching, pending]);

  const pick = (value: string) => {
    onSelectBranch(value);
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
            title={targetBranch ? `Compare with ${targetBranch}` : undefined}
            className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowRight className="size-3.5 shrink-0" />
            <span className="truncate">{targetBranch ?? ""}</span>
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
