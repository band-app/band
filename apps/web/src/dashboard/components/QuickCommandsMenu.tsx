import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { Bot, Pencil, Plus, Settings2, SquareTerminal, Zap } from "lucide-react";
import { useState } from "react";
import {
  useQuickCommandMutations,
  useQuickCommandsFor,
  useRepoNameOfWorktree,
} from "../hooks/use-quick-commands";
import type { QuickCommand } from "../types";
import { QuickCommandDialog } from "./QuickCommandDialog";

/** Settings listens for this to open on a section. */
export const OPEN_SETTINGS_SECTION_EVENT = "band:open-settings-section";

/** The icon of a command's action. */
export function QuickCommandIcon({ command }: { command: QuickCommand }) {
  const Icon = command.action === "agent" ? Bot : SquareTerminal;
  return <Icon className="size-4" aria-hidden="true" />;
}

/**
 * The tab bar's quick-commands button and menu. Lists the commands for the worktree's repo plus
 * the global ones, most recently run first, with a search box once there are enough to need one.
 */
export function QuickCommandsMenu({
  worktreeId,
  onRun,
}: {
  worktreeId: string;
  onRun: (command: QuickCommand) => void;
}) {
  const repoName = useRepoNameOfWorktree(worktreeId);
  const commands = useQuickCommandsFor(repoName);
  const { markRun } = useQuickCommandMutations();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<QuickCommand | null>(null);
  const shown = commands.filter((c) => c.label.toLowerCase().includes(query.trim().toLowerCase()));

  const run = (command: QuickCommand) => {
    markRun.mutate({ id: command.id });
    onRun(command);
  };

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) setQuery("");
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Quick commands"
            className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            data-testid="quick-commands__button"
          >
            <Zap className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          className="w-64"
          onCloseAutoFocus={(e) => {
            // Opening the Edit dialog: let the dialog keep focus instead of the ⚡ trigger.
            if (editing) e.preventDefault();
          }}
          data-testid="quick-commands__menu"
        >
          {commands.length > 5 && (
            <div className="px-1 pb-1">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Search quick commands"
                aria-label="Search quick commands"
                className="h-7 w-full rounded border border-border bg-transparent px-2 text-sm outline-none"
                data-testid="quick-commands__search"
              />
            </div>
          )}
          {shown.map((command) => (
            <DropdownMenuItem
              key={command.id}
              onClick={() => run(command)}
              data-testid="quick-commands__item"
              data-command-id={command.id}
              className="pr-1"
              onKeyDown={(e) => {
                // Radix keeps focus on the row, so the pencil button is not reachable by Tab.
                if (e.key === "ArrowRight") {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenuOpen(false);
                  setEditing(command);
                }
              }}
            >
              <QuickCommandIcon command={command} />
              <span className="min-w-0 flex-1 truncate">{command.label}</span>
              <button
                type="button"
                aria-label={`Edit ${command.label}`}
                data-testid="quick-commands__edit"
                tabIndex={-1}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  setEditing(command);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                  }
                }}
              >
                <Pencil className="size-3.5" aria-hidden="true" />
              </button>
            </DropdownMenuItem>
          ))}
          {commands.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No quick commands yet.</div>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAdding(true)} data-testid="quick-commands__add">
            <Plus className="size-4" aria-hidden="true" />
            Add quick command…
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: "quick-commands" }),
              )
            }
            data-testid="quick-commands__manage"
          >
            <Settings2 className="size-4" aria-hidden="true" />
            Manage quick commands…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <QuickCommandDialog open={adding} onOpenChange={setAdding} defaultRepo={repoName} />
      <QuickCommandDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        command={editing ?? undefined}
        defaultRepo={repoName}
      />
    </>
  );
}
