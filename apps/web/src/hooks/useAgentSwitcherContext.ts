import type React from "react";
import { createContext, useContext } from "react";

export interface AgentSwitcherContextValue {
  chatKey: number;
  setTaskRunning: (running: boolean) => void;
  agentType?: string;
  codingAgentId?: string;
  switchAgent?: (agentId: string) => Promise<void>;
  newSessionRef?: React.MutableRefObject<(() => void) | null>;
}

export const AgentSwitcherContext = createContext<AgentSwitcherContextValue>({
  chatKey: 0,
  setTaskRunning: () => {},
});

export function useAgentSwitcherContext() {
  return useContext(AgentSwitcherContext);
}
