import { Loader2 } from "lucide-react";
import {
  AGENT_STATE_INFO,
  AgentStateDot,
  type TabAgentStatus,
  useDashboardStore,
} from "@/dashboard";
import { ownerOfTerminal } from "../lib/terminal-split-registry";

export type TabAgentStatusKind = TabAgentStatus["status"];

/** Which of several panes' statuses a terminal tab shows: the higher rank. */
export const TAB_STATUS_RANK: Record<TabAgentStatusKind, number> = {
  question: 5,
  failed: 4,
  working: 3,
  monitoring: 2,
  done: 1,
};

/** Spinner while the agent works; the dashboard's dot for every other state. */
export function TabStatusIndicator({
  status,
  testId,
}: {
  status: TabAgentStatusKind;
  testId: string;
}) {
  if (status === "working") {
    return (
      <Loader2
        role="img"
        aria-label={AGENT_STATE_INFO.working.label}
        data-testid={testId}
        data-status={status}
        className="size-3 animate-spin text-muted-foreground"
      />
    );
  }
  return <AgentStateDot status={status} testId={testId} withTitle />;
}

/** The agent status of a chat, from the worktree's status snapshot. */
export function useChatTabStatus(
  worktreeId: string,
  chatId: string,
): TabAgentStatusKind | undefined {
  return useDashboardStore(
    (s) => s.statuses.get(worktreeId)?.tabStatuses?.find((t) => t.chatId === chatId)?.status,
  );
}

/** The agent status of a terminal tab: the most urgent one reported from any
 *  of its split panes. */
export function useTerminalTabStatus(
  worktreeId: string,
  leafId: string,
): TabAgentStatusKind | undefined {
  return useDashboardStore((s) => {
    let found: TabAgentStatusKind | undefined;
    for (const t of s.statuses.get(worktreeId)?.tabStatuses ?? []) {
      if (!t.terminalId || (ownerOfTerminal(t.terminalId) ?? t.terminalId) !== leafId) continue;
      if (!found || TAB_STATUS_RANK[t.status] > TAB_STATUS_RANK[found]) found = t.status;
    }
    return found;
  });
}

export function readCachedTabMeta(chatId: string): { title?: string; agentType?: string } {
  if (!chatId) return {};
  try {
    const raw = sessionStorage.getItem(`band:chat-tab-meta:${chatId}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function writeCachedTabMeta(chatId: string, patch: { title?: string; agentType?: string }) {
  if (!chatId) return;
  try {
    const prev = readCachedTabMeta(chatId);
    sessionStorage.setItem(`band:chat-tab-meta:${chatId}`, JSON.stringify({ ...prev, ...patch }));
  } catch {}
}
