import { AgentIcon } from "@band-app/dashboard-core";
import { ChevronDown, Clock, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc-client";
import { ChatView } from "./ChatView";

interface CodingAgentDef {
  id: string;
  type: string;
  label: string;
}

interface WorkspaceChatPanelProps {
  workspaceId: string;
  visible?: boolean;
  /** Workspace is active (even if the chat tab isn't the focused tab). */
  wsActive?: boolean;
}

export function WorkspaceChatPanel({ workspaceId, visible, wsActive }: WorkspaceChatPanelProps) {
  const [supportsSessionListing, setSupportsSessionListing] = useState(false);
  const [initialSessionId, setInitialSessionId] = useState<string | undefined>(undefined);
  const [sessionQueryDone, setSessionQueryDone] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);
  const [agents, setAgents] = useState<CodingAgentDef[]>([]);
  const [currentAgentId, setCurrentAgentId] = useState<string>("");
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [taskRunning, setTaskRunning] = useState(false);
  // Incremented on agent switch to force ChatView remount
  const [chatKey, setChatKey] = useState(0);
  const newSessionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;

    trpc.sessions.list
      .query({ workspaceId })
      .then((data) => {
        if (cancelled) return;
        if (data.supported) {
          setSupportsSessionListing(true);
          const latest = [...data.sessions].sort((a, b) => b.lastModified - a.lastModified)[0];
          if (latest) {
            setInitialSessionId(latest.sessionId);
          }
        }
        setSessionQueryDone(true);
      })
      .catch((err) => {
        if (!cancelled) setSessionQueryDone(true);
        console.error("[sessions] error:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Load available agents from settings and current workspace agent.
  // Workspace status takes precedence over the settings default, so we
  // fetch both in parallel and apply workspace status last.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatKey intentionally triggers reload after agent switch; currentAgentId excluded to avoid infinite loop
  useEffect(() => {
    let cancelled = false;

    const settingsPromise = trpc.settings.get.query();
    const statusPromise = trpc.statuses.get.query({ workspaceId }).catch(() => null);

    Promise.all([settingsPromise, statusPromise]).then(([settings, status]) => {
      if (cancelled) return;

      const raw = (settings as Record<string, unknown>).codingAgents;
      const codingAgents = Array.isArray(raw) ? (raw as CodingAgentDef[]) : [];
      if (codingAgents.length > 0) {
        const seen = new Set<string>();
        const unique = codingAgents.filter((a) => {
          if (seen.has(a.type)) return false;
          seen.add(a.type);
          return true;
        });
        setAgents(unique);
      }

      // Workspace status agent takes precedence over settings default
      const wsAgentId = status?.agent?.codingAgentId;
      if (wsAgentId) {
        setCurrentAgentId(wsAgentId);
      } else {
        const defaultAgent = (settings as Record<string, unknown>).defaultCodingAgent as
          | string
          | undefined;
        if (defaultAgent) {
          setCurrentAgentId(defaultAgent);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, chatKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleSessionList = useCallback(() => {
    setShowSessionList((prev) => !prev);
  }, []);

  const handleSwitchAgent = useCallback(
    async (agentId: string) => {
      setShowAgentMenu(false);
      if (agentId === currentAgentId) return;
      try {
        await trpc.workspace.switchAgent.mutate({ workspaceId, agentId });
        setCurrentAgentId(agentId);

        // Fetch the latest session for the new agent
        try {
          const data = await trpc.sessions.list.query({ workspaceId });
          if (data.supported && data.sessions.length > 0) {
            const latest = [...data.sessions].sort((a, b) => b.lastModified - a.lastModified)[0];
            setInitialSessionId(latest.sessionId);
            setSupportsSessionListing(true);
          } else {
            setInitialSessionId(undefined);
          }
        } catch {
          setInitialSessionId(undefined);
        }

        // Force ChatView to remount with fresh state
        setChatKey((k) => k + 1);
      } catch (err) {
        console.error("[switchAgent] error:", err);
      }
    },
    [workspaceId, currentAgentId],
  );

  const currentAgent = agents.find((a) => a.id === currentAgentId);
  const switchDisabled = taskRunning;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{workspaceId}</h1>
        </div>
        {agents.length > 1 && (
          <div className="relative">
            <button
              type="button"
              disabled={switchDisabled}
              onClick={() => setShowAgentMenu((prev) => !prev)}
              className={`inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs transition-colors ${
                switchDisabled
                  ? "opacity-50 cursor-not-allowed text-muted-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {currentAgent && <AgentIcon type={currentAgent.type} className="size-3.5 shrink-0" />}
              <span className="hidden max-w-[120px] truncate sm:inline">
                {currentAgent?.label ?? "Default"}
              </span>
              <ChevronDown className="size-3 opacity-50" />
            </button>
            {showAgentMenu && !switchDisabled && (
              <>
                {/* Backdrop to close menu on click outside */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowAgentMenu(false)}
                  onKeyDown={() => {}}
                  role="presentation"
                />
                <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-md">
                  {agents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors hover:bg-accent ${
                        agent.id === currentAgentId
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground"
                      }`}
                      onClick={() => handleSwitchAgent(agent.id)}
                    >
                      <AgentIcon type={agent.type} className="size-3.5 shrink-0" />
                      {agent.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {supportsSessionListing && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={handleToggleSessionList}
              className={`inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-accent ${showSessionList ? "bg-accent text-foreground" : "text-muted-foreground"}`}
            >
              <Clock className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => newSessionRef.current?.()}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="New session"
            >
              <Plus className="size-4" />
            </button>
          </div>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatView
          key={chatKey}
          chatKey={chatKey}
          workspaceId={workspaceId}
          workspaceName={workspaceId}
          supportsSessionListing={supportsSessionListing}
          initialSessionId={initialSessionId}
          sessionQueryDone={sessionQueryDone}
          showSessionList={showSessionList}
          onShowSessionListChange={setShowSessionList}
          onStreamingChange={setTaskRunning}
          onNewSessionRef={newSessionRef}
          agentType={currentAgent?.type}
          codingAgentId={currentAgentId}
          visible={visible}
          wsActive={wsActive}
        />
      </div>
    </div>
  );
}
