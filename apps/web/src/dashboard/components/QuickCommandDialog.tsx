import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "@band-app/ui";
import { ChevronDown, CircleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useQuickCommandMutations } from "../hooks/use-quick-commands";
import { useRepos } from "../hooks/use-repos";
import { useSettingsQuery } from "../hooks/use-settings-query";
import type { QuickCommand, QuickCommandInput } from "../types";

export const QUICK_COMMAND_LABEL_MAX = 80;
export const QUICK_COMMAND_TEXT_MAX = 4000;

const GLOBAL_SCOPE = "__global__";

type Action = "terminal" | "agent";

/** Why the form can't be saved yet, or null when it can. */
function problemWith(label: string, action: Action, body: string, agentId: string): string | null {
  if (!label.trim()) return "Add a label.";
  if (label.length > QUICK_COMMAND_LABEL_MAX) {
    return `The label can be at most ${QUICK_COMMAND_LABEL_MAX} characters.`;
  }
  if (!body.trim()) return action === "terminal" ? "Add a command." : "Add a prompt.";
  if (body.length > QUICK_COMMAND_TEXT_MAX) {
    return `The ${action === "terminal" ? "command" : "prompt"} can be at most ${QUICK_COMMAND_TEXT_MAX} characters.`;
  }
  if (action === "agent" && !agentId) return "Pick an agent.";
  return null;
}

/**
 * Adds or edits a quick command. Opened from a worktree it defaults the scope to that worktree's
 * repo (`defaultRepo`); the scope sits under Advanced. Cmd or Ctrl+Enter saves.
 */
export function QuickCommandDialog({
  open,
  onOpenChange,
  command,
  defaultRepo = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The command to edit. Without it the dialog adds one. */
  command?: QuickCommand;
  /** The repo a new command is scoped to unless the person picks another scope. */
  defaultRepo?: string | null;
}) {
  const { repos } = useRepos();
  const { settings } = useSettingsQuery();
  const agents = settings.codingAgents ?? [];
  const { create, update } = useQuickCommandMutations();

  const [label, setLabel] = useState("");
  const [action, setAction] = useState<Action>("terminal");
  const [terminalText, setTerminalText] = useState("");
  const [appendEnter, setAppendEnter] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState("");
  const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const uid = useId();

  // Start from the command being edited, or a blank form, each time the dialog opens. Only the
  // open transition resets the form; settings loading later must not wipe typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return;
    setServerError(null);
    setAdvancedOpen(false);
    const fallbackAgent = settings.defaultCodingAgent ?? agents[0]?.id ?? "";
    if (command) {
      setLabel(command.label);
      setAction(command.action);
      setTerminalText(command.action === "terminal" ? command.command : "");
      setAppendEnter(command.action === "terminal" ? command.appendEnter : true);
      setPrompt(command.action === "agent" ? command.prompt : "");
      setAgentId(command.action === "agent" ? command.agentId : fallbackAgent);
      setScope(command.repo ?? GLOBAL_SCOPE);
    } else {
      setLabel("");
      setAction("terminal");
      setTerminalText("");
      setAppendEnter(true);
      setPrompt("");
      setAgentId(fallbackAgent);
      setScope(defaultRepo ?? GLOBAL_SCOPE);
    }
  }, [open, command, defaultRepo]);

  const body = action === "terminal" ? terminalText : prompt;
  const problem = problemWith(label, action, body, agentId);
  const saving = create.isPending || update.isPending;
  const repo = scope === GLOBAL_SCOPE ? null : scope;

  const save = () => {
    if (problem || saving) return;
    const input: QuickCommandInput =
      action === "terminal"
        ? { label: label.trim(), repo, action, command: terminalText, appendEnter }
        : { label: label.trim(), repo, action, agentId, prompt };
    const done = {
      onSuccess: () => onOpenChange(false),
      onError: (err: unknown) => setServerError(err instanceof Error ? err.message : String(err)),
    };
    if (command) update.mutate({ id: command.id, command: input }, done);
    else create.mutate(input, done);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        data-testid="quick-command-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{command ? "Edit Quick Command" : "Add Quick Command"}</DialogTitle>
          <DialogDescription>
            Saved items appear in the tab bar menu for one-click run.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex items-end gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label htmlFor={`${uid}-label`} className="text-sm font-medium">
                Label
              </label>
              <Input
                id={`${uid}-label`}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Start dev server"
                data-testid="quick-command-dialog__label"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Action</span>
              <SegmentedControl<Action>
                ariaLabel="Action"
                value={action}
                onChange={setAction}
                options={[
                  { value: "terminal", label: "Terminal" },
                  { value: "agent", label: "Agent" },
                ]}
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-border bg-muted/30">
            <div className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {action === "terminal" ? "Command" : "Prompt"}
            </div>
            <Textarea
              value={body}
              onChange={(e) =>
                action === "terminal" ? setTerminalText(e.target.value) : setPrompt(e.target.value)
              }
              placeholder={action === "terminal" ? "npm run dev" : "Review the diff and list risks"}
              aria-label={action === "terminal" ? "Command" : "Prompt"}
              data-testid="quick-command-dialog__body"
              className="min-h-40 resize-y rounded-none border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {action === "terminal" ? (
                <div className="flex items-center gap-2">
                  <Switch
                    id={`${uid}-enter`}
                    checked={appendEnter}
                    onCheckedChange={setAppendEnter}
                    data-testid="quick-command-dialog__append-enter"
                  />
                  <label htmlFor={`${uid}-enter`}>Append Enter — run immediately</label>
                </div>
              ) : (
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger
                    className="h-7 w-48 text-xs"
                    aria-label="Agent"
                    data-testid="quick-command-dialog__agent"
                  >
                    <SelectValue placeholder="Pick an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <span>Drag corner to resize</span>
            </div>
          </div>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger
              className="flex items-center gap-1.5 text-sm"
              data-testid="quick-command-dialog__advanced"
            >
              <span className="font-medium">Advanced</span>
              <span className="text-muted-foreground">
                · {scope === GLOBAL_SCOPE ? "all repos" : scope}
              </span>
              <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${uid}-scope`} className="text-sm font-medium">
                  Available in
                </label>
                <Select value={scope} onValueChange={setScope}>
                  <SelectTrigger
                    id={`${uid}-scope`}
                    className="w-64"
                    aria-label="Scope"
                    data-testid="quick-command-dialog__scope"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={GLOBAL_SCOPE}>All repos</SelectItem>
                    {repos.map((r) => (
                      <SelectItem key={r.name} value={r.name}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter className="items-center">
          {serverError && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Could not save the quick command"
                  className="mr-auto rounded-sm text-destructive"
                  data-testid="quick-command-dialog__error"
                >
                  <CircleAlert className="size-4" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 break-words text-xs">
                {serverError}
              </PopoverContent>
            </Popover>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="quick-command-dialog__cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={problem !== null || saving}
            title={problem ?? undefined}
            onClick={save}
            data-testid="quick-command-dialog__save"
          >
            Save
            <span className="ml-1.5 text-xs opacity-70">⌘ Enter</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
