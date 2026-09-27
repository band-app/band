import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { Bot } from "lucide-react";
import { AgentIcon, type CodingAgentDefinition, useSettingsQuery } from "@/dashboard";

/**
 * The "New agent" entry of the new-tab menu and the empty state (issue
 * #682). Lists the configured coding agents with the default first. The
 * picked agent starts in this device's mode, a chat or a terminal, so the
 * menu doesn't offer a separate New Chat.
 */

/** Configured coding agents, default first. */
function useSortedCodingAgents(): { agents: CodingAgentDefinition[]; defaultAgentId?: string } {
  const { settings } = useSettingsQuery();
  const agents = settings.codingAgents ?? [];
  const defaultAgentId = settings.defaultCodingAgent ?? agents[0]?.id;
  const sorted = [...agents].sort(
    (a, b) => Number(b.id === defaultAgentId) - Number(a.id === defaultAgentId),
  );
  return { agents: sorted, defaultAgentId };
}

/** `undefined` means the default agent. */
type PickAgent = (agentId: string | undefined) => void;

function AgentItems({
  agents,
  defaultAgentId,
  onPick,
}: {
  agents: CodingAgentDefinition[];
  defaultAgentId?: string;
  onPick: PickAgent;
}) {
  if (agents.length === 0) {
    return (
      <DropdownMenuItem onClick={() => onPick(undefined)} data-testid="workspace-center__new-agent">
        <Bot className="size-4" />
        Default agent
      </DropdownMenuItem>
    );
  }
  return agents.map((agent) => (
    <DropdownMenuItem
      key={agent.id}
      // The default agent goes as "no pick", so it follows the default-agent
      // path (e.g. a chat pane still opens if its launch fails).
      onClick={() => onPick(agent.id === defaultAgentId ? undefined : agent.id)}
      data-testid={`workspace-center__new-agent--${agent.id}`}
    >
      <AgentIcon type={agent.type} className="size-4" />
      {agent.label}
      {agent.id === defaultAgentId && (
        <DropdownMenuShortcut className="tracking-normal">Default</DropdownMenuShortcut>
      )}
    </DropdownMenuItem>
  ));
}

/** "New agent ▸" submenu inside the header "+" menu. */
export function NewAgentSubmenu({ onPick }: { onPick: PickAgent }) {
  const { agents, defaultAgentId } = useSortedCodingAgents();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="workspace-center__new-tab--agent">
        <Bot className="size-4" />
        New agent
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent data-testid="workspace-center__new-agent-menu">
          <AgentItems agents={agents} defaultAgentId={defaultAgentId} onPick={onPick} />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

/** "New agent" button of the empty state, opening the agent list. */
export function NewAgentButton({ className, onPick }: { className: string; onPick: PickAgent }) {
  const { agents, defaultAgentId } = useSortedCodingAgents();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={className} data-testid="workspace-center__empty-new-agent">
          <Bot className="size-4" />
          New agent
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="workspace-center__new-agent-menu">
        <AgentItems agents={agents} defaultAgentId={defaultAgentId} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
