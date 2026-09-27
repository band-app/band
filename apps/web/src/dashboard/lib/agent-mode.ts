import { useCallback, useEffect, useState } from "react";
import type { AgentMode } from "../../shared/agent-sessions";

/**
 * Per-device agent mode (issue #682): whether agents this device starts open
 * as a chat (`gui`) or as the agent's CLI in a terminal (`tui`). Stored in
 * localStorage so each device keeps its own choice. Every launch from this
 * device sends it; with nothing saved the server's `agents.defaultMode`
 * applies.
 */
export const AGENT_MODE_KEY = "band.agent-mode";

const CHANGE_EVENT = "band:agent-mode-change";

export function readAgentMode(): AgentMode | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.localStorage.getItem(AGENT_MODE_KEY);
  return value === "gui" || value === "tui" ? value : undefined;
}

export function writeAgentMode(mode: AgentMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AGENT_MODE_KEY, mode);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function useAgentMode(): [AgentMode | undefined, (mode: AgentMode) => void] {
  const [mode, setMode] = useState<AgentMode | undefined>(() => readAgentMode());

  useEffect(() => {
    const sync = () => setMode(readAgentMode());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const set = useCallback((value: AgentMode) => {
    writeAgentMode(value);
    setMode(value);
  }, []);

  return [mode, set];
}
