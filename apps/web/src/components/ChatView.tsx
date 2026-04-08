import { useChat } from "@ai-sdk/react";
import { AgentIcon } from "@band-app/dashboard-core";
import {
  Badge,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";
import { Bot, ChevronDown, Clock, CodeXml, Loader2, ScrollText, X } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { TaskChatTransport } from "../lib/task-chat-transport";
import { trpc } from "../lib/trpc-client";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import { FileMentionSuggestions } from "./ai-elements/file-mention-suggestions";
import { groupMessageParts } from "./ai-elements/group-parts";
import { Message, MessageContent, MessageFilePart, MessageResponse } from "./ai-elements/message";
import type { PromptInputMessage } from "./ai-elements/prompt-input";
import {
  PromptInput,
  PromptInputActions,
  PromptInputAttach,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./ai-elements/prompt-input";
import { SlashCommandSuggestions } from "./ai-elements/slash-command-suggestions";
import { TaskListWidget } from "./ai-elements/task-list-widget";
import { applyTaskToolCall, isTaskTool, type TaskMap } from "./ai-elements/task-state";
import type { ToolPart } from "./ai-elements/tool";
import type { ToolCallItem } from "./ai-elements/tool-call";
import { ToolCall } from "./ai-elements/tool-call";
import { SessionList } from "./SessionList";

const IN_PROGRESS_STATES = new Set<ToolPart["state"]>([
  "input-available",
  "input-streaming",
  "approval-requested",
  "approval-responded",
]);

const ERROR_STATES = new Set<ToolPart["state"]>(["output-error", "output-denied"]);

function toolPartToItem(part: ToolPart): ToolCallItem {
  const approval = "approval" in part ? (part.approval as { id?: string } | undefined) : undefined;
  const toolName = getToolName(part);
  const displayTitle = "title" in part && typeof part.title === "string" ? part.title : undefined;
  return {
    toolCallId: part.toolCallId,
    toolName,
    displayTitle,
    input: part.input,
    output: part.output,
    errorText: part.errorText,
    isError: ERROR_STATES.has(part.state),
    isInProgress: IN_PROGRESS_STATES.has(part.state),
    // Interactive tools (AskUserQuestion, ExitPlanMode) use toolCallId as
    // the approval key since the canUseTool callback in the agent adapter
    // manages the pending-input lifecycle directly (not through the AI SDK
    // approval mechanism).
    approvalId:
      toolName === "AskUserQuestion" || toolName === "ExitPlanMode"
        ? part.toolCallId
        : approval?.id,
  };
}

function ThinkingIndicator() {
  return (
    <div className="mt-2 flex items-center gap-2 text-muted-foreground">
      <Loader2 className="size-4 lg:size-3.5 animate-spin" />
      <span className="text-base lg:text-sm">Thinking...</span>
    </div>
  );
}

type UIMessageParts = ReturnType<
  typeof import("@ai-sdk/react").useChat
>["messages"][number]["parts"];

type QueueSegment = {
  userPrompt: string | null;
  parts: UIMessageParts;
};

/**
 * Splits an assistant message's parts at `data-prompt` boundaries so each
 * queued task renders as a separate user→assistant pair.
 *
 * Every `data-prompt` becomes a user bubble — they are only emitted for
 * queued messages (never for the initial direct message which is already
 * a real user message in the messages array).
 */
function splitMessageAtQueueBoundaries(parts: UIMessageParts): QueueSegment[] {
  const segments: QueueSegment[] = [];
  let current: QueueSegment = { userPrompt: null, parts: [] };

  for (const part of parts) {
    if (part.type === "data-prompt") {
      // Finish current segment and start a new one
      segments.push(current);
      current = {
        userPrompt: (part as { type: string; data: { text: string } }).data.text,
        parts: [],
      };
      continue;
    }
    // Skip other data-* parts (data-result, data-session) from rendering
    if (typeof part.type === "string" && part.type.startsWith("data-")) continue;
    current.parts.push(part);
  }
  segments.push(current);
  return segments;
}

interface ChatViewProps {
  workspaceId: string;
  workspaceName: string;
  supportsSessionListing: boolean;
  initialSessionId?: string;
  /** True once the parent's sessions.list query has resolved. */
  sessionQueryDone?: boolean;
  showSessionList: boolean;
  onShowSessionListChange: (show: boolean) => void;
  onStreamingChange?: (streaming: boolean) => void;
  onNewSessionRef?: React.MutableRefObject<(() => void) | null>;
  chatKey?: number;
  agentType?: string;
  codingAgentId?: string;
}

export function ChatView({
  workspaceId,
  workspaceName,
  supportsSessionListing,
  initialSessionId,
  sessionQueryDone = false,
  showSessionList,
  onShowSessionListChange,
  onStreamingChange,
  onNewSessionRef,
  chatKey = 0,
  agentType,
  codingAgentId,
}: ChatViewProps) {
  const sessionIdRef = useRef<string | undefined>(undefined);
  const lastEventIdRef = useRef<number | undefined>(undefined);
  const firstEventIdRef = useRef<number | undefined>(undefined);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollHeightBeforePrependRef = useRef<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stickyContextRef = useRef<StickToBottomContext>(null);
  const initialSessionLoadedRef = useRef(false);

  const [skills, setSkills] = useState<
    { name: string; description: string; argumentHint?: string }[]
  >([]);
  useEffect(() => {
    trpc.skills.list
      .query({ workspaceId })
      .then((data) => setSkills(data.skills))
      .catch(() => setSkills([]));
  }, [workspaceId]);

  const [modes, setModes] = useState<{ id: string; name: string; description?: string }[]>([]);
  const modeStorageKey = `band-mode:${workspaceId}`;
  const [selectedMode, setSelectedMode] = useState<string | undefined>(() => {
    try {
      return sessionStorage.getItem(modeStorageKey) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const handleModeSelect = useCallback(
    (mode: string | undefined) => {
      setSelectedMode(mode);
      try {
        if (mode) {
          sessionStorage.setItem(modeStorageKey, mode);
        } else {
          sessionStorage.removeItem(modeStorageKey);
        }
      } catch {
        // ignore storage errors
      }
    },
    [modeStorageKey],
  );
  useEffect(() => {
    trpc.modes.list
      .query({ agentId: codingAgentId || undefined })
      .then((data) => setModes(data.modes as { id: string; name: string; description?: string }[]))
      .catch(() => setModes([]));
    // Derive mode from active task (e.g. reconnecting to a running plan-mode task)
    trpc.tasks.get
      .query({ workspaceId })
      .then((data) => {
        if (data.task?.mode && data.task.status === "running") {
          handleModeSelect(data.task.mode);
        }
      })
      .catch(() => {});
  }, [workspaceId, codingAgentId, handleModeSelect]);

  // Listen for Shift+Tab mode toggle dispatched from the workspace layout
  useEffect(() => {
    const handler = () => {
      if (modes.length < 2) return;
      const currentIndex = modes.findIndex((m) => m.id === selectedMode);
      const nextIndex = currentIndex === -1 ? 1 : (currentIndex + 1) % modes.length;
      handleModeSelect(modes[nextIndex].id);
    };
    window.addEventListener("band:toggle-mode", handler);
    return () => window.removeEventListener("band:toggle-mode", handler);
  }, [modes, selectedMode, handleModeSelect]);

  const [models, setModels] = useState<{ id: string; name: string; description?: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | undefined>(() => {
    try {
      return sessionStorage.getItem(`band-model:${workspaceId}`) ?? undefined;
    } catch {
      return undefined;
    }
  });
  useEffect(() => {
    trpc.models.list
      .query({ agentId: codingAgentId || undefined })
      .then((data) =>
        setModels(data.models as { id: string; name: string; description?: string }[]),
      )
      .catch(() => setModels([]));
  }, [codingAgentId]);
  useEffect(() => {
    try {
      if (selectedModel) {
        sessionStorage.setItem(`band-model:${workspaceId}`, selectedModel);
      } else {
        sessionStorage.removeItem(`band-model:${workspaceId}`);
      }
    } catch {
      // sessionStorage may not be available
    }
  }, [selectedModel, workspaceId]);

  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);

  // Subscribe to queue state changes via a dedicated tRPC subscription.
  // The backend pushes the full queue array on every change (push, shift,
  // remove, clear) so the frontend always has the authoritative state.
  useEffect(() => {
    const subscription = trpc.queue.stream.subscribe(
      { workspaceId },
      {
        onData(data: { messages: string[] }) {
          console.log("subscribe", data.messages);
          setQueuedMessages(data.messages);
        },
      },
    );
    return () => subscription.unsubscribe();
  }, [workspaceId]);

  const transport = useMemo(
    () =>
      new TaskChatTransport(
        workspaceId,
        () => sessionIdRef.current,
        () => lastEventIdRef.current,
      ),
    [workspaceId],
  );

  useEffect(() => {
    transport.mode = selectedMode;
  }, [transport, selectedMode]);

  useEffect(() => {
    transport.model = selectedModel;
  }, [transport, selectedModel]);

  useEffect(() => {
    transport.codingAgentId = codingAgentId;
  }, [transport, codingAgentId]);

  const { messages, sendMessage, status, setMessages, stop, resumeStream } = useChat({
    id: `${workspaceId}:${chatKey}`,
    transport,
    // Don't auto-resume — we control when to resume so that sessionIdRef
    // and lastEventIdRef are populated first (from loadMessages).
    resume: false,
    onData: (dataPart) => {
      // Track eventId from every chunk for gap-fill on reconnect
      const eventId = (dataPart as Record<string, unknown>).eventId;
      if (typeof eventId === "number") {
        lastEventIdRef.current = eventId;
      }

      if (
        dataPart.type === "data-session" &&
        dataPart.data != null &&
        typeof dataPart.data === "object" &&
        "sessionId" in (dataPart.data as Record<string, unknown>)
      ) {
        sessionIdRef.current = (dataPart.data as { sessionId: string }).sessionId;
      }
    },
  });

  // Reconnect to the stream when the tab regains focus, but only if we're
  // not already streaming (avoids creating a duplicate concurrent stream).
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const s = statusRef.current;
      if (s === "streaming" || s === "submitted") return;
      resumeStream();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [resumeStream]);

  // Auto-reconnect when the stream drops with an error (e.g. network issue).
  // Gap-fill from lastEventIdRef picks up where we left off.
  // Uses exponential backoff and a max retry limit to avoid infinite loops.
  const reconnectAttemptsRef = useRef(0);
  useEffect(() => {
    if (status === "streaming" || status === "submitted") {
      // Reset retry counter on successful connection
      reconnectAttemptsRef.current = 0;
      return;
    }
    if (status !== "error") return;
    const attempt = reconnectAttemptsRef.current;
    if (attempt >= 5) return; // Give up after 5 attempts
    reconnectAttemptsRef.current = attempt + 1;
    const delay = Math.min(1000 * 2 ** attempt, 30000);
    const timer = setTimeout(() => {
      resumeStream();
    }, delay);
    return () => clearTimeout(timer);
  }, [status, resumeStream]);

  const abortingRef = useRef(false);

  const handleStop = useCallback(() => {
    abortingRef.current = true;
    transport.abort().finally(() => {
      abortingRef.current = false;
      stop();
    });
  }, [transport, stop]);

  const isStreaming = status === "submitted" || status === "streaming";

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  const handleEscape = useCallback(() => {
    if (isStreaming) {
      handleStop();
    }
  }, [isStreaming, handleStop]);

  const doSendMessage = useCallback(
    (message: PromptInputMessage) => {
      if (message.files?.length) {
        const dataTransfer = new DataTransfer();
        for (const file of message.files) {
          dataTransfer.items.add(file);
        }
        sendMessage({ text: message.text, files: dataTransfer.files });
      } else {
        sendMessage({ text: message.text });
      }
    },
    [sendMessage],
  );

  // Load session history, then attempt to resume the live stream.
  // This ensures sessionIdRef and lastEventIdRef are set BEFORE
  // reconnectToStream runs, so gap-fill replays from the right point.
  const loadMessages = useCallback(
    async (sessionId: string) => {
      // Kill any stale stream before loading + resuming to prevent
      // two concurrent streams writing to the same messages array.
      stop();
      setLoadingHistory(true);
      try {
        const data = await trpc.sessions.messages.query({
          workspaceId,
          sessionId,
        });
        setMessages(data.messages as UIMessage[]);
        lastEventIdRef.current = data.lastEventId ?? undefined;
        firstEventIdRef.current = data.firstEventId ?? undefined;
        setHasMore(data.hasMore);
      } finally {
        setLoadingHistory(false);
      }
      // Now that refs are populated, try to reconnect to a running stream.
      // If no task is running, reconnectToStream returns null and this is a no-op.
      resumeStream();
    },
    [workspaceId, setMessages, resumeStream, stop],
  );

  // Load older messages when the user scrolls to the top of the chat.
  const loadOlderMessages = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const beforeEventId = firstEventIdRef.current;
    if (!sessionId || !beforeEventId || !hasMore || loadingOlder || loadingHistory) {
      return;
    }

    setLoadingOlder(true);
    try {
      const data = await trpc.sessions.messages.query({
        workspaceId,
        sessionId,
        beforeEventId,
        limit: 100,
      });

      if (data.messages.length > 0) {
        // Capture scroll height before prepend for position restoration
        const scrollEl = stickyContextRef.current?.scrollRef?.current;
        if (scrollEl) {
          scrollHeightBeforePrependRef.current = scrollEl.scrollHeight;
        }

        setMessages((prev) => [...(data.messages as UIMessage[]), ...prev]);
        firstEventIdRef.current = data.firstEventId ?? undefined;
        setHasMore(data.hasMore);
      } else {
        setHasMore(false);
      }
    } catch (err) {
      console.error("[loadOlderMessages] error:", err);
    } finally {
      setLoadingOlder(false);
    }
  }, [workspaceId, hasMore, loadingOlder, loadingHistory, setMessages]);

  // Restore scroll position after prepending older messages so the user's
  // viewport doesn't jump. Fires synchronously before the browser paints.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages triggers re-run after prepend
  useLayoutEffect(() => {
    const prevHeight = scrollHeightBeforePrependRef.current;
    if (prevHeight === null) return;
    scrollHeightBeforePrependRef.current = null;

    const scrollEl = stickyContextRef.current?.scrollRef?.current;
    if (!scrollEl) return;

    const delta = scrollEl.scrollHeight - prevHeight;
    if (delta > 0) {
      scrollEl.scrollTop += delta;
    }
  }, [messages]);

  // Observe a sentinel element at the top of the chat to trigger loading
  // older messages when the user scrolls near the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasMore/loadingOlder/loadingHistory re-create observer when state changes
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const scrollEl = stickyContextRef.current?.scrollRef?.current;
    if (!sentinel || !scrollEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadOlderMessages();
        }
      },
      {
        root: scrollEl,
        rootMargin: "200px 0px 0px 0px",
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingOlder, loadingHistory, loadOlderMessages]);

  // Wait for the parent's session query to resolve before doing anything.
  // This avoids the race where an eager resumeStream() opens stream A,
  // then initialSessionId arrives → loadMessages opens stream B, and
  // both pump chunks into the same messages array (causing duplicates).
  useEffect(() => {
    if (initialSessionId && !initialSessionLoadedRef.current) {
      // Session query resolved with a session — load its history.
      // loadMessages will call resumeStream() after setting refs.
      initialSessionLoadedRef.current = true;
      sessionIdRef.current = initialSessionId;
      setActiveSessionId(initialSessionId);
      loadMessages(initialSessionId);
    } else if (sessionQueryDone && !initialSessionId && !initialSessionLoadedRef.current) {
      // Session query resolved with NO sessions — just try resuming
      // a running task (e.g. started from CLI).
      initialSessionLoadedRef.current = true;
      resumeStream();
    }
  }, [initialSessionId, sessionQueryDone, loadMessages, resumeStream]);

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      // Stop any active stream before switching sessions
      stop();
      sessionIdRef.current = sessionId;
      lastEventIdRef.current = undefined;
      firstEventIdRef.current = undefined;
      setHasMore(false);
      setActiveSessionId(sessionId);
      setMessages([]);
      setQueuedMessages([]);
      trpc.queue.clear.mutate({ workspaceId }).catch(() => {});
      onShowSessionListChange(false);
      await loadMessages(sessionId);
    },
    [loadMessages, setMessages, stop, onShowSessionListChange, workspaceId],
  );

  const handleNewSession = useCallback(() => {
    stop();
    sessionIdRef.current = undefined;
    lastEventIdRef.current = undefined;
    firstEventIdRef.current = undefined;
    setHasMore(false);
    setActiveSessionId(undefined);
    setMessages([]);
    setQueuedMessages([]);
    trpc.queue.clear.mutate({ workspaceId }).catch(() => {});
    onShowSessionListChange(false);
  }, [setMessages, stop, onShowSessionListChange, workspaceId]);

  useEffect(() => {
    if (onNewSessionRef) {
      onNewSessionRef.current = handleNewSession;
    }
    return () => {
      if (onNewSessionRef) {
        onNewSessionRef.current = null;
      }
    };
  }, [onNewSessionRef, handleNewSession]);

  const queueMessage = useCallback(
    (text: string) => {
      setQueuedMessages((prev) => [...prev, text]);
      trpc.queue.push.mutate({ workspaceId, text }).catch(() => {});
    },
    [workspaceId],
  );

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (!message.text.trim() && !message.files?.length) return;

      if (isStreaming) {
        // Agent is busy — queue the message on the backend.
        // Optimistic update for instant feedback; subscription corrects if needed.
        queueMessage(message.text);
        return;
      }

      // Check if a task is running in the background (e.g. started from CLI
      // or another tab) that this chat doesn't know about yet.
      try {
        const { task } = await trpc.tasks.get.query({ workspaceId });
        if (task && task.status === "running") {
          queueMessage(message.text);
          return;
        }
      } catch {
        // If the check fails, proceed with sending — the backend will
        // reject with CONFLICT if a task is actually running.
      }

      doSendMessage(message);
    },
    [doSendMessage, isStreaming, workspaceId, queueMessage],
  );

  const handleCancelQueued = useCallback(
    (text: string) => {
      // Optimistic update for instant feedback; subscription corrects if needed.
      setQueuedMessages((prev) => {
        const idx = prev.indexOf(text);
        if (idx === -1) return prev;
        const messages = [...prev.slice(0, idx), ...prev.slice(idx + 1)];

        console.log("cancel", text, messages);

        return messages;
      });
      trpc.queue.remove.mutate({ workspaceId, text }).catch(() => {});
    },
    [workspaceId],
  );

  const taskMap: TaskMap = useMemo(() => {
    let map: TaskMap = new Map();
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (!isToolUIPart(part)) continue;
        const toolPart = part as ToolPart;
        const name = getToolName(toolPart);
        if (!isTaskTool(name)) continue;
        const item = toolPartToItem(toolPart);
        map = applyTaskToolCall(map, item);
      }
    }
    return map;
  }, [messages]);

  const getLastUserMessage = useCallback((): string | undefined => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        const text = messages[i].parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .trim();
        if (text) return text;
      }
      if (messages[i].role === "assistant") {
        // Find the last data-prompt in this message
        const prompts = messages[i].parts.filter((p) => p.type === "data-prompt");
        const last = prompts[prompts.length - 1];
        if (last) return (last as { type: string; data: { text: string } }).data.text;
      }
    }
    return undefined;
  }, [messages]);

  const isEmpty = messages.length === 0;

  if (supportsSessionListing && showSessionList) {
    return (
      <SessionList
        workspaceId={workspaceId}
        activeSessionId={activeSessionId ?? sessionIdRef.current}
        onSelectSession={handleSelectSession}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1" contextRef={stickyContextRef}>
        <ConversationContent>
          {/* Sentinel for scroll-back pagination */}
          {hasMore && !loadingHistory && (
            <div ref={sentinelRef} className="h-px w-full shrink-0" aria-hidden="true" />
          )}

          {/* Loading indicator for older messages */}
          {loadingOlder && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {isEmpty && (
            <ConversationEmptyState
              icon={
                agentType ? (
                  <AgentIcon type={agentType} className="size-8" />
                ) : (
                  <Bot className="size-8" />
                )
              }
              title={workspaceName}
              description="Send a message to start coding"
            />
          )}

          {loadingHistory && messages.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {(() => {
            return messages.map((message, messageIndex) => {
              const isLastMessage = messageIndex === messages.length - 1;
              const isLastAssistant = message.role === "assistant" && isLastMessage;
              const hasPendingInteractiveTool =
                isLastAssistant &&
                message.parts.some(
                  (p) =>
                    isToolUIPart(p) &&
                    IN_PROGRESS_STATES.has(p.state) &&
                    (getToolName(p) === "AskUserQuestion" || getToolName(p) === "ExitPlanMode"),
                );
              const showThinking = isLastAssistant && isStreaming && !hasPendingInteractiveTool;

              if (message.role !== "assistant") {
                // User messages render normally
                const userParts = groupMessageParts(message.parts);
                if (userParts.length === 0) return null;
                return (
                  <Message key={message.id} from="user">
                    <MessageContent>
                      {userParts.map((segment) => {
                        if (
                          segment.type === "text" &&
                          segment.part.type === "text" &&
                          segment.part.text.trim()
                        ) {
                          return (
                            <MessageResponse key={`${message.id}-text-${segment.partIndex}`}>
                              {segment.part.text}
                            </MessageResponse>
                          );
                        }
                        if (segment.type === "file") {
                          return (
                            <MessageFilePart
                              key={`${message.id}-file-${segment.partIndex}`}
                              part={segment.part}
                            />
                          );
                        }
                        return null;
                      })}
                    </MessageContent>
                  </Message>
                );
              }

              // Assistant message
              const hasDataPrompts = message.parts.some((p) => p.type === "data-prompt");

              if (!hasDataPrompts) {
                // No queue boundaries — render as before
                const visibleParts = message.parts.filter(
                  (p) =>
                    (p.type === "text" && p.text.trim()) || p.type === "file" || isToolUIPart(p),
                );
                if (visibleParts.length === 0 && !showThinking) return null;
                return (
                  <Message key={message.id} from="assistant">
                    <MessageContent>
                      {groupMessageParts(message.parts).map((segment) => {
                        if (segment.type === "text") {
                          const { part, partIndex } = segment;
                          if (part.type === "text" && part.text.trim()) {
                            return (
                              <MessageResponse key={`${message.id}-text-${partIndex}`}>
                                {part.text}
                              </MessageResponse>
                            );
                          }
                          return null;
                        }
                        if (segment.type === "file") {
                          return (
                            <MessageFilePart
                              key={`${message.id}-file-${segment.partIndex}`}
                              part={segment.part}
                            />
                          );
                        }
                        const item = toolPartToItem(segment.part);
                        if (isTaskTool(item.toolName)) return null;
                        return (
                          <ToolCall key={`${message.id}-tool-${segment.partIndex}`} item={item} />
                        );
                      })}
                      {showThinking && <ThinkingIndicator />}
                    </MessageContent>
                  </Message>
                );
              }

              // Split at data-prompt boundaries
              const segments = splitMessageAtQueueBoundaries(message.parts);

              return segments.map((segment, segIdx) => {
                const visibleParts = groupMessageParts(segment.parts);
                const isLastSegment = segIdx === segments.length - 1;
                const segKey = segment.userPrompt ?? "initial";

                return (
                  <Fragment key={`${message.id}-seg-${segKey}`}>
                    {segment.userPrompt && (
                      <Message from="user">
                        <MessageContent>
                          <MessageResponse>{segment.userPrompt}</MessageResponse>
                        </MessageContent>
                      </Message>
                    )}
                    {(visibleParts.length > 0 || (isLastSegment && showThinking)) && (
                      <Message from="assistant">
                        <MessageContent>
                          {visibleParts.map((seg) => {
                            if (seg.type === "text") {
                              const { part, partIndex } = seg;
                              if (part.type === "text" && part.text.trim()) {
                                return (
                                  <MessageResponse
                                    key={`${message.id}-${segKey}-text-${partIndex}`}
                                  >
                                    {part.text}
                                  </MessageResponse>
                                );
                              }
                              return null;
                            }
                            if (seg.type === "file") {
                              return (
                                <MessageFilePart
                                  key={`${message.id}-${segKey}-file-${seg.partIndex}`}
                                  part={seg.part}
                                />
                              );
                            }
                            const item = toolPartToItem(seg.part);
                            if (isTaskTool(item.toolName)) return null;
                            return (
                              <ToolCall
                                key={`${message.id}-${segKey}-tool-${seg.partIndex}`}
                                item={item}
                              />
                            );
                          })}
                          {isLastSegment && showThinking && <ThinkingIndicator />}
                        </MessageContent>
                      </Message>
                    )}
                  </Fragment>
                );
              });
            });
          })()}
          {isStreaming && (!messages.length || messages[messages.length - 1].role === "user") && (
            <Message from="assistant">
              <MessageContent>
                <ThinkingIndicator />
              </MessageContent>
            </Message>
          )}

          {queuedMessages.map((text) => (
            <QueuedMessageBubble key={text} text={text} onCancel={() => handleCancelQueued(text)} />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl shrink-0 px-3 lg:px-4 pt-2 pb-4 standalone:pb-[env(safe-area-inset-bottom)]">
        <TaskListWidget tasks={taskMap} workspaceId={workspaceId} />
        <PromptInput onSubmit={handleSubmit} draftKey={workspaceId}>
          <SlashCommandSuggestions skills={skills} />
          <FileMentionSuggestions workspaceId={workspaceId} />
          <PromptInputTextarea
            placeholder="Type a message..."
            onEscape={handleEscape}
            onPreviousMessage={getLastUserMessage}
          />
          <PromptInputActions>
            <div className="flex items-center gap-0.5">
              <PromptInputAttach />
              {models.length > 0 && (
                <ModelMenu
                  models={models}
                  selected={selectedModel}
                  onSelect={setSelectedModel}
                  agentType={agentType}
                />
              )}
              {modes.length > 0 && (
                <ModeMenu modes={modes} selected={selectedMode} onSelect={handleModeSelect} />
              )}
            </div>
            <PromptInputSubmit
              status={status}
              onStop={handleStop}
              queueCount={queuedMessages.length}
            />
          </PromptInputActions>
        </PromptInput>
      </div>
    </div>
  );
}

function ModeIcon({ modeId, className }: { modeId: string; className?: string }) {
  switch (modeId) {
    case "plan":
      return <ScrollText className={className} />;
    case "edit":
      return <CodeXml className={className} />;
    default:
      return <ChevronDown className={className} />;
  }
}

function ModeMenu({
  modes,
  selected,
  onSelect,
}: {
  modes: { id: string; name: string; description?: string }[];
  selected: string | undefined;
  onSelect: (mode: string | undefined) => void;
}) {
  const current = modes.find((m) => m.id === selected) ?? modes[0];
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ModeIcon modeId={current?.id ?? ""} className="size-3" />
              {current?.name ?? "Mode"}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>⇧Tab</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-[140px]">
        {modes.map((mode) => (
          <DropdownMenuItem
            key={mode.id}
            onClick={() => onSelect(mode.id)}
            className={cn(
              "flex items-start gap-2",
              mode.id === (selected ?? modes[0]?.id) ? "bg-accent" : "",
            )}
          >
            <ModeIcon modeId={mode.id} className="size-4 mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{mode.name}</span>
              {mode.description && (
                <span className="text-xs text-muted-foreground">{mode.description}</span>
              )}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelMenu({
  models,
  selected,
  onSelect,
  agentType,
}: {
  models: { id: string; name: string; description?: string }[];
  selected: string | undefined;
  onSelect: (model: string | undefined) => void;
  agentType?: string;
}) {
  const current = models.find((m) => m.id === selected) ?? models[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {agentType ? (
            <AgentIcon type={agentType} className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
          {current?.name ?? "Model"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[140px]">
        {models.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onClick={() => onSelect(model.id)}
            className={cn(
              "flex flex-col items-start gap-0.5",
              model.id === (selected ?? models[0]?.id) ? "bg-accent" : "",
            )}
          >
            <span className="text-sm font-medium">{model.name}</span>
            {model.description && (
              <span className="text-xs text-muted-foreground">{model.description}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QueuedMessageBubble({ text, onCancel }: { text: string; onCancel: () => void }) {
  return (
    <div className="group is-user flex w-full max-w-[90%] flex-col gap-2 ml-auto justify-end opacity-60">
      <div className="flex min-w-0 max-w-full flex-col gap-2 break-words text-base ml-auto w-fit rounded-md bg-secondary px-4 py-3 text-foreground">
        <MessageResponse>{text}</MessageResponse>
        <div className="flex items-center justify-end gap-2 mt-1">
          <Badge variant="outline" className="text-xs text-muted-foreground">
            <Clock className="size-3" />
            Queued
          </Badge>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="size-3" />
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
