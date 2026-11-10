import { Button, cn, Input } from "@band-app/ui";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import type { HostView } from "../../hooks/use-update-status";
import { AgentIcon } from "../agent-icons";
import { ErrorPopover } from "./ErrorPopover";
import { errorText } from "./worker-format";

type State = HostView["agentCommandStates"][number];

/** One agent on one worker: a line with its name and command, and an edit control for the override. */
function AgentCommandRow({
  host,
  state,
  editable,
  onChanged,
}: {
  host: HostView;
  state: State;
  editable: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(state.override ?? "");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (command: string | null) => {
    setError(null);
    try {
      await trpc.workers.setAgentCommand.mutate({
        hostId: host.id,
        agentId: state.agentId,
        command,
      });
      if (command === null) setDraft("");
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const testId = `settings__host-agent-command-${state.agentId}`;
  const missing = state.found === false;
  return (
    <li className="space-y-1.5 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <span
          data-testid={`${testId}-status`}
          data-state={state.found === true ? "found" : missing ? "missing" : "unknown"}
          className={cn("size-2 shrink-0 rounded-full", missing ? "bg-destructive" : "bg-success")}
        />
        <AgentIcon type={state.type} className="size-4 shrink-0" />
        <span className="shrink-0 text-sm font-medium">{state.label}</span>
        <span
          data-testid={`${testId}-effective`}
          data-effective={state.effective ?? ""}
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            missing ? "text-destructive" : "text-muted-foreground",
          )}
          title={missing ? `${state.effective} not found on ${host.name}` : undefined}
        >
          {state.effective ?? ""}
        </span>
        {missing ? (
          <span role="alert" className="sr-only" data-testid={`${testId}-not-found`}>
            {state.effective} not found on {host.name}
          </span>
        ) : null}
        {error ? (
          <ErrorPopover
            label={`Could not save the ${state.label} command`}
            testId={`${testId}-error`}
            message={error}
          />
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={`${testId}-toggle`}
          aria-label={`Command of ${state.label} on ${host.name}`}
          aria-expanded={editing}
          onClick={() => setEditing((open) => !open)}
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
      {editing ? (
        <div className="flex items-center gap-2 pl-6">
          <Input
            aria-label={`${state.label} command on ${host.name}`}
            data-testid={`${testId}-input`}
            className="h-8 flex-1 text-xs"
            placeholder="Default binary"
            disabled={!editable}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {editable ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`${testId}-save`}
                disabled={draft.trim() === (state.override ?? "") || draft.trim() === ""}
                onClick={() => void save(draft.trim())}
              >
                Save
              </Button>
              {state.override ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid={`${testId}-clear`}
                  onClick={() => void save(null)}
                >
                  Clear
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** A worker's coding agents, one line each. The pencil opens the command override field. */
export function HostAgentCommands({
  host,
  isAdmin,
  onChanged,
}: {
  host: HostView;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  if (host.agentCommandStates.length === 0) {
    return <p className="text-xs text-muted-foreground">No agents reported yet.</p>;
  }
  return (
    <ul
      className="divide-y divide-border rounded-md border border-border"
      data-testid="settings__host-agents-commands"
    >
      {host.agentCommandStates.map((state) => (
        <AgentCommandRow
          key={`${state.agentId}:${state.override ?? ""}`}
          host={host}
          state={state}
          editable={isAdmin}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}
