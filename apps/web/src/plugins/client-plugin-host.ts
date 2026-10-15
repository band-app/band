import type { ClientPluginHost } from "@band-app/plugin-api/client";
import { useQuery } from "@tanstack/react-query";
import { readAgentMode } from "@/dashboard/lib/agent-mode";
import { queryClient } from "@/dashboard/query-client";
import { AGENT_LAUNCHING_EVENT, OPEN_PANE_EVENT } from "../lib/agent-pane-events";
import { markChatFresh, newChatId, newTerminalId } from "../lib/leaf-instance-ids";
import { openExternalUrl } from "../lib/open-external-url";
import { trpc } from "../lib/trpc-client";
import { PluginMarkdown } from "./PluginMarkdown";

const reviewQueryKey = (worktreeId: string) => ["worktreeReview", worktreeId] as const;

/** The core's side of the plugin client API, backed by tRPC and TanStack Query. */
export const clientPluginHost: ClientPluginHost = {
  useWorktreeReview(worktreeId, { enabled, refetchInterval }) {
    const query = useQuery({
      queryKey: reviewQueryKey(worktreeId),
      queryFn: () => trpc.reviews.forWorktree.query({ worktreeId }),
      enabled,
      // Polling refreshes the panel; this only saves a `gh` call when the
      // user flips between tabs or worktrees.
      staleTime: 15_000,
      refetchInterval:
        typeof refetchInterval === "function"
          ? (q) => refetchInterval(q.state.data)
          : refetchInterval,
    });
    return {
      data: query.data,
      isLoading: query.isLoading,
      isFetching: query.isFetching,
      error: query.error,
      refetch: () => void query.refetch(),
    };
  },

  async mergeReview(worktreeId, method) {
    try {
      await trpc.reviews.merge.mutate({ worktreeId, method });
    } finally {
      void queryClient.invalidateQueries({ queryKey: reviewQueryKey(worktreeId) });
    }
  },

  async startAgent(worktreeId, prompt) {
    // The dock activates the tab of every id announced here, whether the
    // server's `chat-created` / `terminal-created` event or this call's
    // answer arrives first.
    const chatId = newChatId();
    const terminalId = newTerminalId();
    const mode = readAgentMode();
    if (mode !== "tui") markChatFresh(chatId);
    window.dispatchEvent(
      new CustomEvent(AGENT_LAUNCHING_EVENT, { detail: { worktreeId, chatId, terminalId } }),
    );
    const result = await trpc.agentSessions.launch.mutate({
      worktreeId,
      prompt,
      mode,
      chatId,
      terminalId,
    });
    const paneId = result.mode === "tui" ? result.terminalId : result.chatId;
    if (paneId) {
      window.dispatchEvent(
        new CustomEvent(OPEN_PANE_EVENT, {
          detail: { worktreeId, paneId, kind: result.mode === "tui" ? "term" : "chat" },
        }),
      );
    }
    return result.mode === "tui" ? { terminalId: result.terminalId } : { chatId: result.chatId };
  },

  openPane(worktreeId, paneId) {
    window.dispatchEvent(new CustomEvent(OPEN_PANE_EVENT, { detail: { worktreeId, paneId } }));
  },

  openUrl(url) {
    // Plugin UI shows URLs from third parties (a check's details link), and
    // the desktop opens them with the system's handler for their scheme.
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return;
    }
    if (protocol === "https:" || protocol === "http:") openExternalUrl(url);
  },

  openFile(worktreeId, path, line) {
    // The center dock listens for this, filters on the worktree id and
    // opens the file at the line.
    window.dispatchEvent(
      new CustomEvent("band:lsp-navigate", { detail: { filePath: path, worktreeId, line } }),
    );
  },

  Markdown: PluginMarkdown,
};
