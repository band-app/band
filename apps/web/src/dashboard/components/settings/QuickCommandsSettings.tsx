import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@band-app/ui";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useQuickCommandMutations, useQuickCommands } from "../../hooks/use-quick-commands";
import { useSettingsQuery } from "../../hooks/use-settings-query";
import type { QuickCommand } from "../../types";
import { QuickCommandDialog } from "../QuickCommandDialog";
import { QuickCommandIcon } from "../QuickCommandsMenu";
import { SettingsSection } from "./SettingsSection";

/** One line of what the command does: the text, or the agent and its prompt. */
function summary(command: QuickCommand, agentLabel: (id: string) => string): string {
  return command.action === "terminal"
    ? command.command
    : `${agentLabel(command.agentId)}: ${command.prompt}`;
}

/** Settings > Quick commands: every saved command with its scope and action. */
export function QuickCommandsSettings() {
  const commands = useQuickCommands();
  const { remove } = useQuickCommandMutations();
  const { settings } = useSettingsQuery();
  const agentLabel = (id: string) => settings.codingAgents?.find((a) => a.id === id)?.label ?? id;
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<QuickCommand | undefined>();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<QuickCommand | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = commands.filter(
    (c) => !needle || `${c.label} ${summary(c, agentLabel)}`.toLowerCase().includes(needle),
  );

  return (
    <SettingsSection
      title="Quick commands"
      description="Saved terminal commands and agent prompts. Run them from the tab bar, a terminal's right-click menu or the iOS app."
      action={
        <Button
          variant="outline"
          size="sm"
          data-testid="settings-quick-commands__add"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3" />
          New quick command
        </Button>
      }
    >
      <div data-testid="settings-quick-commands">
        <div data-slot="settings-row" className="px-4 py-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search quick commands"
            aria-label="Search quick commands"
            data-testid="settings-quick-commands__search"
          />
        </div>
        {shown.length === 0 && (
          <p
            data-slot="settings-row"
            data-testid="settings-quick-commands__empty"
            className="px-4 py-3 text-sm text-muted-foreground"
          >
            {commands.length === 0 ? "No quick commands yet" : "No quick commands match"}
          </p>
        )}
        {shown.map((command) => (
          <div
            key={command.id}
            data-slot="settings-row"
            data-testid="settings-quick-commands__row"
            data-command-id={command.id}
            className="flex items-center gap-3 px-4 py-3"
          >
            <QuickCommandIcon command={command} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{command.label}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {summary(command, agentLabel)}
              </div>
            </div>
            <span
              className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              data-testid="settings-quick-commands__scope"
            >
              {command.repo ?? "All repos"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${command.label}`}
              data-testid="settings-quick-commands__edit"
              onClick={() => setEditing(command)}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${command.label}`}
              data-testid="settings-quick-commands__delete"
              onClick={() => setDeleting(command)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <QuickCommandDialog open={adding} onOpenChange={setAdding} />
      <QuickCommandDialog
        open={editing !== undefined}
        onOpenChange={(open) => !open && setEditing(undefined)}
        command={editing}
      />
      <DeleteQuickCommandDialog
        command={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate({ id: deleting.id });
          setDeleting(null);
        }}
      />
    </SettingsSection>
  );
}

function DeleteQuickCommandDialog({
  command,
  onCancel,
  onConfirm,
}: {
  command: QuickCommand | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={command !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="sm:max-w-[425px]"
        data-testid="quick-command-delete-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Delete quick command</DialogTitle>
          <DialogDescription>
            Delete <strong>{command?.label}</strong>? This removes it on every device.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="quick-command-delete-dialog__confirm"
            onClick={onConfirm}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
