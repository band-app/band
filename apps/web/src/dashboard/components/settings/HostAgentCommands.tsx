import {
  Accordion,
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionTriggerInline,
  Button,
  cn,
  Input,
} from "@band-app/ui";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import type { HostView } from "../../hooks/use-update-status";
import { AgentIcon } from "../agent-icons";

type State = HostView["agentCommandStates"][number];

/** One agent on one worker: its name and command in the header, the override field when open. */
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
  const missing = state.found === false;
  return (
    <AccordionItem value={state.agentId} className="border-b-0">
      <AccordionHeader className="flex items-center gap-3 px-3 py-2">
        <span
          data-testid={`${testId}-status`}
          data-state={state.found === true ? "found" : missing ? "missing" : "unknown"}
          className={cn("size-2 shrink-0 rounded-full", missing ? "bg-destructive" : "bg-success")}
        />
        <AgentIcon type={state.type} className="size-4 shrink-0" />
        <AccordionTriggerInline
          data-testid={`${testId}-toggle`}
          aria-label={`Command of ${state.label} on ${host.name}`}
          className="flex-1 rounded-md text-left text-sm font-medium text-foreground"
        >
          {state.label}
        </AccordionTriggerInline>
        <span
          data-testid={`${testId}-effective`}
          data-effective={state.effective ?? ""}
          className={cn("truncate text-xs", missing ? "text-destructive" : "text-muted-foreground")}
          title={missing ? `${state.effective} not found on ${host.name}` : undefined}
        >
          {state.effective ?? ""}
        </span>
        {missing ? (
          <span role="alert" className="sr-only" data-testid={`${testId}-not-found`}>
            {state.effective} not found on {host.name}
          </span>
        ) : null}
        <AccordionTriggerInline
          aria-label={`Toggle command settings for ${state.label}`}
          className="-mr-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180"
        >
          <ChevronDown className="size-4 shrink-0 transition-transform duration-200" />
        </AccordionTriggerInline>
      </AccordionHeader>
      <AccordionContent className="space-y-1 px-3 pb-2 pl-11">
        <div className="flex items-center gap-2">
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
        {error ? (
          <div role="alert" className="text-xs text-destructive" data-testid={`${testId}-error`}>
            {error}
          </div>
        ) : null}
      </AccordionContent>
    </AccordionItem>
  );
}

/** A worker's coding agents, one collapsed row each. Open a row to set its command. */
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
    <Accordion
      type="multiple"
      className="mt-2 w-full rounded-md border border-border"
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
    </Accordion>
  );
}
