import { Button, Input } from "@band-app/ui";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import type { HostView } from "../../hooks/use-update-status";

type State = HostView["agentCommandStates"][number];

/**
 * One agent's command on one worker: the override field, the command the agent runs there and,
 * for an override, whether the worker found it on its PATH.
 */
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
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const testId = `settings__host-agent-command-${state.agentId}`;
  return (
    <div className="space-y-1" data-testid="settings__host-agent-command-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 shrink-0">{state.label}</span>
        {editable ? (
          <>
            <Input
              aria-label={`${state.label} command on ${host.name}`}
              data-testid={`${testId}-input`}
              className="h-7 w-56 text-xs"
              placeholder={state.effective ?? "default binary"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
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
        <span data-testid={`${testId}-effective`} data-effective={state.effective ?? ""}>
          Runs: {state.effective ?? "default binary"}
        </span>
        {state.found === false ? (
          <span role="alert" className="text-destructive" data-testid={`${testId}-not-found`}>
            {state.effective} not found on {host.name}
          </span>
        ) : null}
        {state.found === true ? <span data-testid={`${testId}-found`}>found</span> : null}
      </div>
      {error ? (
        <div role="alert" className="text-destructive" data-testid={`${testId}-error`}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** The Agents section of a worker: a command field per configured coding agent. */
export function HostAgentCommands({
  host,
  isAdmin,
  onChanged,
}: {
  host: HostView;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  if (host.agentCommandStates.length === 0) return null;
  return (
    <div
      className="space-y-1 text-xs text-muted-foreground"
      data-testid="settings__host-agents-commands"
    >
      <div className="font-medium text-foreground">Agent commands</div>
      {host.agentCommandStates.map((state) => (
        <AgentCommandRow
          key={`${state.agentId}:${state.override ?? ""}`}
          host={host}
          state={state}
          editable={isAdmin}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}
