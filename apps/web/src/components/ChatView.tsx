import { useChat } from "@ai-sdk/react";
import { AgentIcon, useExperimentalContextMeter } from "@band-app/dashboard-core";
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";
import {
  Bot,
  ChevronDown,
  Clock,
  CodeXml,
  GitBranch,
  GripHorizontal,
  Loader2,
  Plus,
  ScrollText,
  X,
} from "lucide-react";
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

/**
 * Skeleton placeholder shown while a session's history is being fetched.
 * Mimics the alternating user→assistant bubble shape so the layout doesn't
 * jump once messages arrive — much less jarring than a centered spinner.
 */
function SkeletonBar({ widthClass, className }: { widthClass: string; className?: string }) {
  return <div className={cn("h-3 rounded bg-muted/70", widthClass, className)} />;
}

function ConversationSkeleton() {
  return (
    <output
      className="flex animate-pulse flex-col gap-6"
      aria-busy="true"
      aria-label="Loading messages"
    >
      {/* User bubble — right-aligned, narrower */}
      <Message from="user">
        <MessageContent>
          <div className="flex flex-col gap-2 py-1">
            <SkeletonBar widthClass="w-48" className="bg-foreground/10" />
            <SkeletonBar widthClass="w-32" className="bg-foreground/10" />
          </div>
        </MessageContent>
      </Message>

      {/* Assistant bubble — full width, several lines */}
      <Message from="assistant">
        <MessageContent>
          <div className="flex flex-col gap-2 pt-1">
            <SkeletonBar widthClass="w-3/4" />
            <SkeletonBar widthClass="w-full" />
            <SkeletonBar widthClass="w-5/6" />
            <SkeletonBar widthClass="w-2/3" />
          </div>
        </MessageContent>
      </Message>

      {/* A second user/assistant pair for longer-feeling conversations */}
      <Message from="user">
        <MessageContent>
          <div className="flex flex-col gap-2 py-1">
            <SkeletonBar widthClass="w-40" className="bg-foreground/10" />
          </div>
        </MessageContent>
      </Message>

      <Message from="assistant">
        <MessageContent>
          <div className="flex flex-col gap-2 pt-1">
            <SkeletonBar widthClass="w-2/3" />
            <SkeletonBar widthClass="w-4/5" />
            <SkeletonBar widthClass="w-1/2" />
          </div>
        </MessageContent>
      </Message>
    </output>
  );
}

type UIMessageParts = ReturnType<
  typeof import("@ai-sdk/react").useChat
>["messages"][number]["parts"];

interface QueuedFilePart {
  mediaType: string;
  url: string;
  filename?: string;
}

type QueueSegment = {
  userPrompt: string | null;
  userFiles?: QueuedFilePart[];
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
      const data = (part as { type: string; data: { text: string; files?: QueuedFilePart[] } })
        .data;
      current = {
        userPrompt: data.text,
        userFiles: data.files,
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

interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  /** Approximate max input context window in tokens, when known. */
  contextWindow?: number;
}

interface AgentGroup {
  agentId: string;
  agentType: string;
  agentLabel: string;
  models: ModelInfo[];
  defaultModel?: string;
}

interface UsageData {
  /** Provider that produced this snapshot. Drives legacy context-size math. */
  provider?: "claude" | "codex" | "gemini" | "opencode" | "cursor";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningOutputTokens?: number;
  /** Provider-aware total context tokens (preferred over summing fields). */
  contextTokens?: number;
  /** Cumulative processed tokens for the session/thread when available. */
  totalProcessedTokens?: number;
  /** Authoritative model context window from the agent SDK. */
  maxContextTokens?: number;
}

interface ChatViewProps {
  workspaceId: string;
  chatId: string;
  workspaceName: string;
  supportsSessionListing: boolean;
  initialSessionId?: string;
  /** True once the parent's sessions.list query has resolved. */
  sessionQueryDone?: boolean;
  showSessionList: boolean;
  onShowSessionListChange: (show: boolean) => void;
  onStreamingChange?: (streaming: boolean) => void;
  onNewSessionRef?: React.MutableRefObject<(() => void) | null>;
  /** Called when the active session changes (user picks one, or a new one starts). */
  onActiveSessionChange?: (sessionId: string | undefined) => void;
  chatKey?: number;
  agentType?: string;
  codingAgentId?: string;
  /** Called when the user picks a model under a different coding agent. */
  onSwitchAgent?: (agentId: string) => void;
  visible?: boolean;
  /** Workspace is active (even if the chat tab isn't the focused tab). */
  wsActive?: boolean;
}

export function ChatView({
  workspaceId,
  chatId,
  workspaceName,
  supportsSessionListing,
  initialSessionId,
  sessionQueryDone = false,
  showSessionList: _showSessionList,
  onShowSessionListChange,
  onStreamingChange,
  onNewSessionRef,
  onActiveSessionChange,
  chatKey = 0,
  agentType,
  codingAgentId,
  onSwitchAgent,
  visible,
  wsActive,
}: ChatViewProps) {
  const sessionIdRef = useRef<string | undefined>(undefined);
  const lastEventIdRef = useRef<number | undefined>(undefined);
  const firstEventIdRef = useRef<number | undefined>(undefined);
  // Index of the first JSONL message currently in `messages`. Used as the
  // exclusive upper bound for the next "older messages" pagination request.
  // Set when the server returns history sourced from JSONL (firstEventId is
  // null). When pagination is buffer-based, this stays undefined.
  const firstMessageIndexRef = useRef<number | undefined>(undefined);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  // If we have an initialSessionId we're going to call loadMessages() in the
  // mount effect below — initialize loadingHistory to true so the skeleton
  // shows on the first render rather than briefly flashing the empty state.
  const [loadingHistory, setLoadingHistory] = useState(!!initialSessionId);
  // True once the user explicitly clears the session via "New session". The
  // `initialSessionId` prop reflects the parent's persisted activeSessionId
  // and may stay stale for a tick (or longer) after handleNewSession fires,
  // so we ignore it for skeleton/empty-state decisions once cleared.
  const [initialSessionCleared, setInitialSessionCleared] = useState(false);
  // The session this view is currently on, considering local navigation:
  //   - activeSessionId once the mount effect / handleSelectSession sets it
  //   - else the initialSessionId prop, unless the user explicitly cleared
  // This is what render conditions should consult, not initialSessionId.
  const currentSessionId =
    activeSessionId ?? (initialSessionCleared ? undefined : initialSessionId);
  const [hasMore, setHasMore] = useState(false);
  const [usage, setUsage] = useState<UsageData | undefined>(undefined);
  const [contextMeterEnabled] = useExperimentalContextMeter();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollHeightBeforePrependRef = useRef<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stickyContextRef = useRef<StickToBottomContext>(null);
  // Gate that ensures we run the initial history-load exactly once for a
  // given (chatKey, initialSessionId) tuple. Distinct from the connect
  // retry loop, which is allowed to fire multiple times.
  const initialHistoryLoadedRef = useRef(false);
  // Mirrors `useChat`'s status so the retry loop can read it without
  // forcing a re-render of the closure.
  const statusRef = useRef<"submitted" | "streaming" | "ready" | "error">("ready");
  // Holds the AbortController for the in-flight reconnect attempt so a new
  // attempt (or unmount) can cancel the old one cleanly.
  const connectAbortRef = useRef<AbortController | null>(null);
  const prevVisibleRef = useRef(visible);

  // Scroll to bottom when the panel becomes visible (e.g. switching tabs in dockview).
  // The scroll container may have had zero height while hidden, so StickToBottom
  // couldn't track position. We force-scroll after layout settles.
  useEffect(() => {
    const wasHidden = prevVisibleRef.current === false;
    prevVisibleRef.current = visible;
    if (!wasHidden || !visible) return;

    const scrollToEnd = () => {
      // Try the StickToBottom API first
      stickyContextRef.current?.scrollToBottom?.("instant");
      // Also force the raw scroll element as a fallback
      const el = stickyContextRef.current?.scrollRef?.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    };

    // Run after layout settles — rAF alone isn't enough because dockview
    // may still be resizing the container after the tab switch.
    requestAnimationFrame(() => {
      scrollToEnd();
      // Second pass catches late layout shifts
      setTimeout(scrollToEnd, 50);
    });
  }, [visible]);

  const [skills, setSkills] = useState<
    { name: string; description: string; argumentHint?: string }[]
  >([]);
  useEffect(() => {
    trpc.skills.list
      .query({ workspaceId, chatId })
      .then((data) => setSkills(data.skills))
      .catch(() => setSkills([]));
  }, [workspaceId, chatId]);

  const [modes, setModes] = useState<{ id: string; name: string; description?: string }[]>([]);
  const [selectedMode, setSelectedMode] = useState<string | undefined>();
  const handleModeSelect = useCallback(
    (mode: string | undefined) => {
      setSelectedMode(mode);
      trpc.chats.update
        .mutate({ chatId, mode: mode ?? "" })
        .catch((err) => console.error("[ChatView] error persisting mode:", err));
    },
    [chatId],
  );
  useEffect(() => {
    trpc.modes.list
      .query({ agentId: codingAgentId || undefined })
      .then((data) => setModes(data.modes as { id: string; name: string; description?: string }[]))
      .catch(() => setModes([]));
    // Hydrate persisted mode from the chat record, or derive from active task
    trpc.chats.get
      .query({ chatId })
      .then((data) => {
        const persisted = data.chat?.mode;
        if (typeof persisted === "string" && persisted) {
          setSelectedMode(persisted);
        }
      })
      .catch(() => {});
    trpc.tasks.get
      .query({ workspaceId, chatId })
      .then((data) => {
        if (data.task?.mode && data.task.status === "running") {
          setSelectedMode(data.task.mode);
        }
      })
      .catch(() => {});
  }, [workspaceId, chatId, codingAgentId]);

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

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [agentGroups, setAgentGroups] = useState<AgentGroup[]>([]);
  // Default model from agent settings (per agent type)
  const [agentDefaultModel, setAgentDefaultModel] = useState<string | undefined>();
  // Explicit user override from the model dropdown
  const [userModelOverride, setUserModelOverride] = useState<string | undefined>();
  // Effective model: user override takes precedence, then agent default
  const selectedModel = userModelOverride ?? agentDefaultModel;
  // Resolved ModelInfo for the active selection — flows the SDK-reported
  // contextWindow into the meter so it doesn't have to guess from the id.
  const selectedModelInfo = useMemo(
    () => models.find((m) => m.id === selectedModel),
    [models, selectedModel],
  );

  // Drop the SDK-reported `maxContextTokens` when the model changes — that
  // value was for the prior model and would otherwise stick until the next
  // turn refreshes it (e.g. switching Sonnet 1M → Haiku 200k would still
  // show the 1M denominator). Falling back to undefined lets ContextMeter
  // use the static MODEL_CONTEXT_WINDOWS entry for the new model in the
  // meantime.
  useEffect(() => {
    if (!selectedModel) return;
    setUsage((prev) => {
      if (!prev || prev.maxContextTokens === undefined) return prev;
      const { maxContextTokens: _drop, ...rest } = prev;
      return rest;
    });
  }, [selectedModel]);

  useEffect(() => {
    const modelsP = trpc.models.listAll
      .query()
      .then((data) => {
        setAgentGroups(data.agents as AgentGroup[]);
        // Derive current agent's models from the groups
        const currentGroup = (data.agents as AgentGroup[]).find((g) => g.agentId === codingAgentId);
        if (currentGroup) {
          setModels(currentGroup.models);
          setAgentDefaultModel(currentGroup.defaultModel || undefined);
        } else if ((data.agents as AgentGroup[]).length > 0) {
          const first = (data.agents as AgentGroup[])[0];
          setModels(first.models);
          setAgentDefaultModel(first.defaultModel || undefined);
        }
      })
      .catch(() => setAgentGroups([]));

    // Hydrate persisted model override from the chat record
    const chatP = trpc.chats.get
      .query({ chatId })
      .then((data) => {
        const persisted = data.chat?.model;
        if (typeof persisted === "string" && persisted) {
          setUserModelOverride(persisted);
        }
      })
      .catch(() => {});

    void Promise.all([modelsP, chatP]);
  }, [codingAgentId, chatId]);

  const handleModelSelect = useCallback(
    (model: string | undefined) => {
      setUserModelOverride(model);
      trpc.chats.update
        .mutate({ chatId, model: model ?? "" })
        .catch((err) => console.error("[ChatView] error persisting model:", err));
    },
    [chatId],
  );

  interface QueuedMessageView {
    id: string;
    text: string;
    files?: QueuedFilePart[];
  }
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessageView[]>([]);

  // Subscribe to queue state changes via a dedicated tRPC subscription.
  // The backend pushes the full queue array on every change (push, shift,
  // remove, clear) so the frontend always has the authoritative state.
  useEffect(() => {
    const subscription = trpc.queue.stream.subscribe(
      { workspaceId, chatId },
      {
        onData(data: { messages: QueuedMessageView[] }) {
          setQueuedMessages(data.messages);
        },
      },
    );
    return () => subscription.unsubscribe();
  }, [workspaceId, chatId]);

  const transport = useMemo(
    () =>
      new TaskChatTransport(
        workspaceId,
        chatId,
        () => sessionIdRef.current,
        () => lastEventIdRef.current,
      ),
    [workspaceId, chatId],
  );

  // Close the SSE connection when the transport is replaced (chat/workspace
  // change) or the component unmounts. This releases the HTTP connection back
  // to the browser pool — critical because browsers limit HTTP/1.1 connections
  // to ~6 per origin, and each SSE stream holds one open.
  useEffect(() => {
    return () => transport.close();
  }, [transport]);

  useEffect(() => {
    transport.mode = selectedMode;
  }, [transport, selectedMode]);

  useEffect(() => {
    transport.model = userModelOverride ?? agentDefaultModel;
  }, [transport, userModelOverride, agentDefaultModel]);

  useEffect(() => {
    transport.codingAgentId = codingAgentId;
  }, [transport, codingAgentId]);

  const { messages, sendMessage, status, setMessages, stop, resumeStream } = useChat({
    id: `${chatId}:${chatKey}`,
    transport,
    // Don't auto-resume — we control when to resume so that sessionIdRef
    // and lastEventIdRef are populated first (from loadMessages).
    resume: false,
    onData: (dataPart) => {
      if (
        dataPart.type === "data-session" &&
        dataPart.data != null &&
        typeof dataPart.data === "object" &&
        "sessionId" in (dataPart.data as Record<string, unknown>)
      ) {
        const sid = (dataPart.data as { sessionId: string }).sessionId;
        sessionIdRef.current = sid;
        onActiveSessionChange?.(sid);
      } else if (
        dataPart.type === "data-usage" &&
        dataPart.data != null &&
        typeof dataPart.data === "object"
      ) {
        const data = dataPart.data as Partial<UsageData>;
        if (typeof data.inputTokens === "number" && typeof data.outputTokens === "number") {
          const next: UsageData = {
            provider: data.provider,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            cacheReadTokens: data.cacheReadTokens,
            cacheCreationTokens: data.cacheCreationTokens,
            reasoningOutputTokens: data.reasoningOutputTokens,
            contextTokens: data.contextTokens,
            totalProcessedTokens: data.totalProcessedTokens,
            maxContextTokens: data.maxContextTokens,
          };
          // SSE gap-fill can replay older usage chunks on reconnect. Prefer
          // monotonic totalProcessedTokens when present so context may shrink
          // after compaction; older providers fall back to context size.
          setUsage((prev) => {
            const shouldUseNext =
              prev?.totalProcessedTokens !== undefined && next.totalProcessedTokens !== undefined
                ? next.totalProcessedTokens >= prev.totalProcessedTokens
                : usageContextSize(next) >= usageContextSize(prev);
            return shouldUseNext ? next : prev;
          });
        }
      }
    },
  });

  const abortingRef = useRef(false);

  // Keep statusRef in sync with the live `status` so the connect-retry loop
  // (which can outlive a single render) can observe transitions to
  // "submitted"/"streaming" and stop retrying.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const handleStop = useCallback(() => {
    abortingRef.current = true;
    transport.abort().finally(() => {
      abortingRef.current = false;
      stop();
    });
  }, [transport, stop]);

  const isStreaming = status === "submitted" || status === "streaming";

  // Cancel any in-flight reconnect retry. Called before opening a new one
  // and on unmount/dependency change.
  const cancelConnectAttempt = useCallback(() => {
    if (connectAbortRef.current) {
      connectAbortRef.current.abort();
      connectAbortRef.current = null;
    }
  }, []);

  /**
   * Try to reconnect to a running task's SSE stream, retrying with backoff
   * until one of:
   *   - `useChat.status` flips to "submitted"/"streaming" (success)
   *   - the server confirms no task is running (clean give-up)
   *   - we exhaust the retry budget
   *   - the attempt is cancelled (unmount / new attempt)
   *
   * Why retry? `GET /api/tasks/:chatId/stream` returns 204 if the in-memory
   * task hasn't been registered yet (registration lag, server boot, brief
   * race during workspace switch). The Vercel AI SDK treats 204 as "nothing
   * to resume" and silently leaves status at "ready" — no thinking indicator,
   * no error, no log. The retry loop turns that silent failure into either
   * a real connection or a clean give-up.
   */
  const connectToRunningStream = useCallback(async () => {
    cancelConnectAttempt();
    const controller = new AbortController();
    connectAbortRef.current = controller;
    const signal = controller.signal;

    // Read the latest status off the ref. Wrapping the read in a function
    // keeps TypeScript from narrowing the ref's union type across awaits —
    // `statusRef.current` is mutable, so a check earlier in the function
    // shouldn't shrink its type later.
    const isAttached = (): boolean => {
      const s = statusRef.current;
      return s === "submitted" || s === "streaming";
    };

    // Backoff schedule (ms): first attempt is immediate, then 250 → 500 →
    // 1000 → 2000. Total wait ~3.75s before giving up — long enough to
    // cover task registration lag without blocking the UI for too long.
    const delays = [0, 250, 500, 1000, 2000];

    try {
      for (let i = 0; i < delays.length; i++) {
        if (signal.aborted) return;

        if (delays[i] > 0) {
          await new Promise<void>((r) => setTimeout(r, delays[i]));
          if (signal.aborted) return;
        }

        // If `useChat` is already streaming (e.g. a sendMessage just took
        // over while we were waiting), we're done.
        if (isAttached()) return;

        // Attempt the resume. The transport aborts any prior in-flight
        // connection internally, so calling this repeatedly is safe.
        resumeStream();

        // Give the AI SDK a tick to update `status`. If the GET succeeds
        // and the server has events to send, status flips to "streaming"
        // shortly after the first chunk arrives.
        await new Promise<void>((r) => setTimeout(r, 350));
        if (signal.aborted) return;

        if (isAttached()) return;

        // Status didn't change → resumeStream resolved to null (204) or
        // hasn't seen events yet. Ask the server: is anything actually
        // running? If not, give up cleanly. If yes, keep retrying.
        try {
          const { running } = await trpc.tasks.isRunning.query({ workspaceId, chatId });
          if (signal.aborted) return;
          if (!running) return;
        } catch {
          // Network blip — keep retrying with the same backoff.
        }
      }
    } finally {
      if (connectAbortRef.current === controller) {
        connectAbortRef.current = null;
      }
    }
  }, [workspaceId, chatId, resumeStream, cancelConnectAttempt]);

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
      cancelConnectAttempt();
      setLoadingHistory(true);
      try {
        const data = await trpc.sessions.messages.query({
          workspaceId,
          chatId,
          sessionId,
        });
        setMessages(data.messages as unknown as UIMessage[]);
        lastEventIdRef.current = data.lastEventId ?? undefined;
        firstEventIdRef.current = data.firstEventId ?? undefined;
        firstMessageIndexRef.current =
          (data as { firstMessageIndex?: number | null }).firstMessageIndex ?? undefined;
        setHasMore(data.hasMore);
        // Re-hydrate the context meter from the persisted snapshot so it
        // survives task completion and page refreshes.
        if (data.lastUsage) {
          setUsage({
            provider: data.lastUsage.provider,
            inputTokens: data.lastUsage.inputTokens,
            outputTokens: data.lastUsage.outputTokens,
            cacheReadTokens: data.lastUsage.cacheReadTokens,
            cacheCreationTokens: data.lastUsage.cacheCreationTokens,
            reasoningOutputTokens: data.lastUsage.reasoningOutputTokens,
            contextTokens: data.lastUsage.contextTokens,
            totalProcessedTokens: data.lastUsage.totalProcessedTokens,
            maxContextTokens: data.lastUsage.maxContextTokens,
          });
        }
      } finally {
        setLoadingHistory(false);
      }
      // Now that refs are populated, try to reconnect to a running stream
      // with retries. If no task is running on the server, the loop gives
      // up cleanly after one round-trip to tasks.isRunning.
      void connectToRunningStream();
    },
    [workspaceId, chatId, setMessages, connectToRunningStream, stop, cancelConnectAttempt],
  );

  // Load older messages when the user scrolls to the top of the chat.
  // Uses the buffer cursor (firstEventId) when available, otherwise the
  // JSONL cursor (firstMessageIndex). Exactly one of the two is set.
  const loadOlderMessages = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const beforeEventId = firstEventIdRef.current;
    const beforeMessageIndex = firstMessageIndexRef.current;
    const haveCursor = beforeEventId !== undefined || beforeMessageIndex !== undefined;
    if (!sessionId || !haveCursor || !hasMore || loadingOlder || loadingHistory) {
      return;
    }

    setLoadingOlder(true);
    try {
      const data = await trpc.sessions.messages.query({
        workspaceId,
        chatId,
        sessionId,
        beforeEventId,
        beforeMessageIndex,
        limit: 100,
      });

      if (data.messages.length > 0) {
        // Capture scroll height before prepend for position restoration
        const scrollEl = stickyContextRef.current?.scrollRef?.current;
        if (scrollEl) {
          scrollHeightBeforePrependRef.current = scrollEl.scrollHeight;
        }

        setMessages((prev) => [...(data.messages as unknown as UIMessage[]), ...prev]);
        firstEventIdRef.current = data.firstEventId ?? undefined;
        firstMessageIndexRef.current =
          (data as { firstMessageIndex?: number | null }).firstMessageIndex ?? undefined;
        setHasMore(data.hasMore);
      } else {
        setHasMore(false);
      }
    } catch (err) {
      console.error("[loadOlderMessages] error:", err);
    } finally {
      setLoadingOlder(false);
    }
  }, [workspaceId, chatId, hasMore, loadingOlder, loadingHistory, setMessages]);

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
  //
  // The history-load itself is one-shot per (chatKey, initialSessionId):
  // we don't want to refetch all messages on every render. The reconnect
  // attempt embedded in loadMessages (via connectToRunningStream) IS
  // retryable, and is also re-triggered on tab focus / network online
  // events below.
  useEffect(() => {
    if (initialHistoryLoadedRef.current) return;
    if (initialSessionId) {
      initialHistoryLoadedRef.current = true;
      sessionIdRef.current = initialSessionId;
      setActiveSessionId(initialSessionId);
      loadMessages(initialSessionId);
    } else if (sessionQueryDone && !initialSessionId) {
      // No sessions — just try resuming a running task (e.g. started from
      // CLI). Use the retrying connect helper instead of a single
      // resumeStream() call so we cover the registration-lag window.
      initialHistoryLoadedRef.current = true;
      void connectToRunningStream();
    }
  }, [initialSessionId, sessionQueryDone, loadMessages, connectToRunningStream]);

  // Re-attempt reconnect when the tab regains focus or the network comes
  // back online. We skip if we're already streaming or already attempting,
  // and we ask the server first to avoid a retry storm when nothing's
  // actually running.
  useEffect(() => {
    const maybeReconnect = () => {
      if (statusRef.current === "submitted" || statusRef.current === "streaming") return;
      if (connectAbortRef.current) return;
      // Fire-and-forget: connectToRunningStream itself handles the
      // is-running short-circuit.
      void connectToRunningStream();
    };
    const onFocus = () => maybeReconnect();
    const onOnline = () => maybeReconnect();
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [connectToRunningStream]);

  // Release the SSE connection while the workspace is hidden so cached
  // (but inactive) workspaces don't pin HTTP/1.1 connection slots —
  // browsers cap at ~6 per origin and the dockview LRU keeps several
  // workspaces alive at once. The server-side task keeps running
  // independently; on reactivation we re-fetch the persisted session
  // history (so messages that landed while we were hidden show up) and
  // then resume any still-running stream via Last-Event-ID.
  const prevWsActiveRef = useRef(wsActive);
  useEffect(() => {
    const prev = prevWsActiveRef.current;
    prevWsActiveRef.current = wsActive;

    if (prev && !wsActive) {
      // Workspace just deactivated — abort any in-flight reconnect retry
      // and close the active SSE fetch. transport.close() is a no-op when
      // there's no open connection (idle chat).
      cancelConnectAttempt();
      transport.close();
    } else if (!prev && wsActive && sessionIdRef.current) {
      // Workspace just reactivated and we know about a session — refresh
      // from the persisted JSONL state. loadMessages also calls
      // connectToRunningStream at the end, so an in-flight task is
      // resumed from Last-Event-ID. If the task completed while we were
      // hidden, this is the only path that surfaces the final message
      // (the resume endpoint returns 204 once the in-memory task is
      // gone, so resumeStream alone wouldn't pick it up).
      void loadMessages(sessionIdRef.current);
    }
  }, [wsActive, transport, cancelConnectAttempt, loadMessages]);

  // Cancel any in-flight reconnect on unmount or when the underlying
  // chat/key changes (transport gets recreated).
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatKey/chatId trigger cleanup
  useEffect(() => {
    return () => cancelConnectAttempt();
  }, [chatKey, chatId, cancelConnectAttempt]);

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      // Stop any active stream before switching sessions
      stop();
      cancelConnectAttempt();
      sessionIdRef.current = sessionId;
      lastEventIdRef.current = undefined;
      firstEventIdRef.current = undefined;
      firstMessageIndexRef.current = undefined;
      setHasMore(false);
      setActiveSessionId(sessionId);
      onActiveSessionChange?.(sessionId);
      setMessages([]);
      setQueuedMessages([]);
      setUsage(undefined);
      trpc.queue.clear.mutate({ workspaceId, chatId }).catch(() => {});
      onShowSessionListChange(false);
      await loadMessages(sessionId);
    },
    [
      loadMessages,
      setMessages,
      stop,
      cancelConnectAttempt,
      onShowSessionListChange,
      onActiveSessionChange,
      workspaceId,
      chatId,
    ],
  );

  const handleNewSession = useCallback(() => {
    stop();
    cancelConnectAttempt();
    sessionIdRef.current = undefined;
    lastEventIdRef.current = undefined;
    firstEventIdRef.current = undefined;
    firstMessageIndexRef.current = undefined;
    setHasMore(false);
    setActiveSessionId(undefined);
    setInitialSessionCleared(true);
    onActiveSessionChange?.(undefined);
    setMessages([]);
    setQueuedMessages([]);
    setUsage(undefined);
    trpc.queue.clear.mutate({ workspaceId, chatId }).catch(() => {});
    onShowSessionListChange(false);
  }, [
    setMessages,
    stop,
    cancelConnectAttempt,
    onShowSessionListChange,
    onActiveSessionChange,
    workspaceId,
    chatId,
  ]);

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

  // Global keyboard shortcut: Cmd/Ctrl+Shift+N → start new session.
  // Only the visible chat pane in the active workspace responds.
  useEffect(() => {
    if (!visible || !wsActive) return;
    const onNewChat = () => handleNewSession();
    window.addEventListener("band:new-chat-session", onNewChat);
    return () => window.removeEventListener("band:new-chat-session", onNewChat);
  }, [visible, wsActive, handleNewSession]);

  const queueMessage = useCallback(
    async (message: PromptInputMessage) => {
      // Convert browser File[] to base64 data URLs so they can be
      // serialized through tRPC. Files are uploaded to disk only when
      // the queued message is drained (server-side).
      const files = await Promise.all(
        (message.files ?? []).map(
          (file): Promise<QueuedFilePart> =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                resolve({
                  mediaType: file.type,
                  url: reader.result as string,
                  filename: file.name,
                });
              };
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(file);
            }),
        ),
      );

      // Optimistic update with a temporary id; subscription corrects when
      // the server's response arrives.
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setQueuedMessages((prev) => [
        ...prev,
        { id: tempId, text: message.text, files: files.length > 0 ? files : undefined },
      ]);
      trpc.queue.push
        .mutate({
          workspaceId,
          chatId,
          text: message.text,
          ...(files.length > 0 && { files }),
        })
        .catch(() => {});
    },
    [workspaceId, chatId],
  );

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (!message.text.trim() && !message.files?.length) return;

      if (isStreaming) {
        // Agent is busy — queue the message on the backend.
        // Optimistic update for instant feedback; subscription corrects if needed.
        await queueMessage(message);
        return;
      }

      // Check if a task is running in the background (e.g. started from CLI
      // or another tab) that this chat doesn't know about yet.
      try {
        const { task } = await trpc.tasks.get.query({ workspaceId, chatId });
        if (task && task.status === "running") {
          await queueMessage(message);
          return;
        }
      } catch {
        // If the check fails, proceed with sending — the backend will
        // reject with CONFLICT if a task is actually running.
      }

      doSendMessage(message);
    },
    [doSendMessage, isStreaming, workspaceId, chatId, queueMessage],
  );

  const handleCancelQueued = useCallback(
    (id: string) => {
      // Optimistic update for instant feedback; subscription corrects if needed.
      setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
      trpc.queue.remove.mutate({ workspaceId, chatId, id }).catch(() => {});
    },
    [workspaceId, chatId],
  );

  const handleEditQueued = useCallback(
    (id: string, text: string) => {
      // Optimistic update for instant feedback; subscription corrects if needed.
      setQueuedMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)));
      trpc.queue.update.mutate({ workspaceId, chatId, id, text }).catch(() => {});
    },
    [workspaceId, chatId],
  );

  // Pointer sensor with a small activation distance so a click on the
  // drag handle (or anywhere) doesn't accidentally start a drag —
  // the user has to actually move a few pixels first.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleReorderQueued = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      setQueuedMessages((prev) => {
        const oldIdx = prev.findIndex((m) => m.id === active.id);
        const newIdx = prev.findIndex((m) => m.id === over.id);
        if (oldIdx === -1 || newIdx === -1) return prev;
        const reordered = arrayMove(prev, oldIdx, newIdx);
        // Persist the new order. queue.set replaces the whole queue;
        // the subscription will broadcast the same shape back so the
        // optimistic state and the server stay in sync.
        trpc.queue.set
          .mutate({
            workspaceId,
            chatId,
            messages: reordered.map((m) => ({
              id: m.id,
              text: m.text,
              ...(m.files && m.files.length > 0 && { files: m.files }),
            })),
          })
          .catch(() => {});
        return reordered;
      });
    },
    [workspaceId, chatId],
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1" contextRef={stickyContextRef}>
        <ConversationContent>
          {/* Sentinel for scroll-back pagination */}
          {hasMore && !loadingHistory && (
            <div ref={sentinelRef} className="h-px w-full shrink-0" aria-hidden="true" />
          )}

          {/* Loading indicator for older messages — skeleton row matching
              the bubble layout so the prepended history doesn't pop. */}
          {loadingOlder && (
            <output
              className="flex animate-pulse flex-col gap-2 py-3"
              aria-busy="true"
              aria-label="Loading older messages"
            >
              <SkeletonBar widthClass="w-2/3" />
              <SkeletonBar widthClass="w-3/4" />
              <SkeletonBar widthClass="w-1/2" />
            </output>
          )}

          {/*
            Empty state: only when we know there's no session to load.
            Skeleton: when sessions are still being fetched, when we have a
            session but the message-load effect hasn't kicked in yet, or while
            the load is in flight. This prevents the empty state from
            flashing on first workspace load before chats.get resolves.
          */}
          {isEmpty && sessionQueryDone && !currentSessionId && !loadingHistory && (
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

          {messages.length === 0 && (loadingHistory || !sessionQueryDone || !!currentSessionId) && (
            <ConversationSkeleton />
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
                          {segment.userFiles?.map((file, fileIdx) => (
                            <MessageFilePart
                              key={`${message.id}-${segKey}-userfile-${fileIdx}`}
                              part={{ type: "file", ...file }}
                            />
                          ))}
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
          {queuedMessages.length > 0 && (
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleReorderQueued}
            >
              <SortableContext
                items={queuedMessages.map((m) => m.id)}
                strategy={verticalListSortingStrategy}
              >
                {queuedMessages.map((m) => (
                  <QueuedMessageBubble
                    key={m.id}
                    id={m.id}
                    text={m.text}
                    files={m.files}
                    onCancel={() => handleCancelQueued(m.id)}
                    onEdit={(newText) => handleEditQueued(m.id, newText)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl shrink-0 px-3 lg:px-4 pt-2 pb-4 standalone:pb-[env(safe-area-inset-bottom)]">
        <TaskListWidget tasks={taskMap} workspaceId={workspaceId} />
        <PromptInput
          onSubmit={handleSubmit}
          draftKey={workspaceId}
          visible={visible}
          wsActive={wsActive}
        >
          <SlashCommandSuggestions skills={skills} />
          <FileMentionSuggestions workspaceId={workspaceId} />
          <PromptInputTextarea
            placeholder="Type a message..."
            onEscape={handleEscape}
            onPreviousMessage={getLastUserMessage}
            // Shift+Tab toggles Edit/Plan mode, but only while the chat
            // input has focus — the same band:toggle-mode listener picks
            // up palette invocations as well.
            onShiftTab={() => window.dispatchEvent(new CustomEvent("band:toggle-mode"))}
          />
          <PromptInputActions>
            <div className="flex items-center gap-0.5">
              <PromptInputAttach />
              {supportsSessionListing && (
                <SessionHistoryMenu
                  workspaceId={workspaceId}
                  chatId={chatId}
                  activeSessionId={activeSessionId ?? sessionIdRef.current}
                  onSelectSession={handleSelectSession}
                  onNewSession={handleNewSession}
                />
              )}
              {contextMeterEnabled && (
                <ContextMeter usage={usage} model={selectedModel} modelInfo={selectedModelInfo} />
              )}
              {(agentGroups.length > 0 || models.length > 0) && (
                <AgentModelMenu
                  agentGroups={agentGroups}
                  currentAgentId={codingAgentId}
                  currentAgentType={agentType}
                  selectedModel={selectedModel}
                  onSelectModel={handleModelSelect}
                  onSwitchAgent={onSwitchAgent}
                  disabled={status !== "ready" && status !== "error"}
                />
              )}
              {modes.length > 0 && (
                <ModeMenu modes={modes} selected={selectedMode} onSelect={handleModeSelect} />
              )}
            </div>
            <PromptInputSubmit status={status} onStop={handleStop} />
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
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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

function AgentModelMenu({
  agentGroups,
  currentAgentId,
  currentAgentType,
  selectedModel,
  onSelectModel,
  onSwitchAgent,
  disabled,
}: {
  agentGroups: AgentGroup[];
  currentAgentId?: string;
  currentAgentType?: string;
  selectedModel: string | undefined;
  onSelectModel: (model: string | undefined) => void;
  onSwitchAgent?: (agentId: string) => void;
  disabled?: boolean;
}) {
  const currentGroup = agentGroups.find((g) => g.agentId === currentAgentId) ?? agentGroups[0];
  const currentModels = currentGroup?.models ?? [];
  const current = currentModels.find((m) => m.id === selectedModel) ?? currentModels[0];
  const displayName = current?.name ?? "Model";
  const showGroups = agentGroups.length > 1;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          {currentAgentType ? (
            <AgentIcon type={currentAgentType} className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
          {displayName}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px] max-h-[400px] overflow-y-auto">
        {showGroups
          ? agentGroups.map((group, groupIndex) => {
              const isCurrentAgent = group.agentId === currentAgentId;
              return (
                <Fragment key={group.agentId}>
                  {groupIndex > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="flex items-center gap-1.5">
                    <AgentIcon type={group.agentType} className="size-3.5" />
                    {group.agentLabel}
                  </DropdownMenuLabel>
                  <DropdownMenuGroup>
                    {group.models.length > 0 ? (
                      group.models.map((model) => (
                        <DropdownMenuItem
                          key={`${group.agentId}:${model.id}`}
                          onClick={() => {
                            if (isCurrentAgent) {
                              onSelectModel(model.id);
                            } else {
                              onSwitchAgent?.(group.agentId);
                            }
                          }}
                          className={cn(
                            "flex flex-col items-start gap-0.5 pl-6",
                            isCurrentAgent && model.id === selectedModel ? "bg-accent" : "",
                          )}
                        >
                          <ModelLine model={model} />
                          {model.description && (
                            <span className="text-xs text-muted-foreground">
                              {model.description}
                            </span>
                          )}
                        </DropdownMenuItem>
                      ))
                    ) : (
                      <DropdownMenuItem
                        onClick={() => {
                          if (!isCurrentAgent) {
                            onSwitchAgent?.(group.agentId);
                          }
                        }}
                        className="pl-6 text-muted-foreground"
                      >
                        <span className="text-sm italic">
                          {isCurrentAgent ? "Default model" : "Switch to this agent"}
                        </span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </Fragment>
              );
            })
          : currentModels.map((model) => (
              <DropdownMenuItem
                key={model.id}
                onClick={() => onSelectModel(model.id)}
                className={cn(
                  "flex flex-col items-start gap-0.5",
                  model.id === selectedModel ? "bg-accent" : "",
                )}
              >
                <ModelLine model={model} />
                {model.description && (
                  <span className="text-xs text-muted-foreground">{model.description}</span>
                )}
              </DropdownMenuItem>
            ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function relativeTime(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// Approximate context window per model. Fallback for the chat context meter
// when an adapter doesn't report `maxContextTokens` live and the picker
// doesn't supply a `contextWindow` on the ModelInfo. Claude Code adapter
// always passes the SDK's `getContextUsage().maxTokens`, so this map is
// fallback-only for Claude; Codex/Gemini/Cursor SDKs don't expose a context
// window field, so they rely on this map directly.
//
// Order matters: `getContextWindow` walks entries with the longest key first
// so "claude-opus-4-7[1m]" matches before "claude-opus-4-7".
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude — Opus 4.x ships a 200k default and a separate [1m] long-context
  // tier. Sonnet 4.6 is 1M GA at standard pricing (the [1m] suffix is a
  // legacy alias). Haiku 4.5 stays at 200k.
  "claude-opus-4-7[1m]": 1_000_000,
  "claude-opus-4-6[1m]": 1_000_000,
  "claude-opus-4-7": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6[1m]": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  // OpenAI — GPT-5 family runs at 400k inside Codex CLI (the Responses API
  // tier is 1M but Band shells out to the codex binary which caps at 400k).
  "gpt-5": 400_000,
  "gpt-4.1": 1_000_000,
  "gpt-4o": 128_000,
  // Gemini 2.5 Pro and Flash are both 1M (~1,048,576).
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
};

function getContextWindow(model: string | undefined): number {
  if (!model) return 200_000;
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  // Prefix match — sort by descending key length so longer/more specific
  // keys win (e.g. "claude-opus-4-7[1m]" before "claude-opus-4-7").
  const entries = Object.entries(MODEL_CONTEXT_WINDOWS).sort(([a], [b]) => b.length - a.length);
  for (const [key, value] of entries) {
    if (model.startsWith(key)) return value;
  }
  return 200_000;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Compact context-window label, e.g. 200000 → "200k", 1_000_000 → "1M". */
function formatCtxWindow(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function ModelLine({ model }: { model: ModelInfo }) {
  return (
    <span className="flex w-full items-baseline justify-between gap-2">
      <span className="text-sm font-medium">{model.name}</span>
      {model.contextWindow !== undefined && (
        <span className="text-[10px] uppercase tabular-nums text-muted-foreground">
          {formatCtxWindow(model.contextWindow)} ctx
        </span>
      )}
    </span>
  );
}

// Donut geometry — 24×24 viewBox keeps the SVG aligned with `size-4`
// (16px) Tailwind utility while leaving enough whitespace for a 3-unit
// stroke without clipping. Radius 9, stroke 3 → circumference ≈ 56.55.
const DONUT_RADIUS = 9;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

function ContextMeter({
  usage,
  model,
  modelInfo,
}: {
  usage: UsageData | undefined;
  model: string | undefined;
  modelInfo?: ModelInfo;
}) {
  // Adapters compute context size with provider-aware semantics and pass it
  // through `contextTokens`. Only fall back to summation for legacy snapshots
  // that predate that field. Provider semantics differ:
  //   • Claude: `inputTokens` is the *uncached* portion → must add cache.
  //   • Codex/OpenAI: `inputTokens` is the full prompt (already includes
  //     cached) → adding `cacheReadTokens` would double-count.
  // `legacyContextSize` uses the `provider` discriminator (with a
  // cacheCreationTokens-presence fallback for old snapshots).
  const contextSize = usage ? (usage.contextTokens ?? legacyContextSize(usage)) : 0;
  // Window denominator priority:
  //   1. SDK-reported `maxContextTokens` (Claude only, auto-compact-aware)
  //   2. `modelInfo.contextWindow` from the adapter's listModels()
  //   3. Static MODEL_CONTEXT_WINDOWS map keyed by id prefix
  const window = usage?.maxContextTokens ?? modelInfo?.contextWindow ?? getContextWindow(model);
  const pct = Math.min(100, (contextSize / window) * 100);
  const pctRounded = Math.round(pct);
  const danger = pct >= 85;
  const warn = !danger && pct >= 65;
  // Monochrome gray progression — the donut sits among other muted-foreground
  // affordances in PromptInputActions, so it should read as a quiet status
  // glyph rather than a colored alert. Higher usage = darker shade.
  const progressColor = danger
    ? "stroke-foreground"
    : warn
      ? "stroke-muted-foreground"
      : "stroke-muted-foreground/60";
  // Empty arc would render as a full ring at strokeDashoffset = circumference,
  // so dot-treat the 0% case explicitly to match a "nothing yet" affordance.
  const dashOffset = pct <= 0 ? DONUT_CIRCUMFERENCE : DONUT_CIRCUMFERENCE * (1 - pct / 100);

  // Popover (controlled) instead of Tooltip so the breakdown is reachable on
  // touch devices where hover doesn't fire reliably. On desktop we still want
  // the lightweight hover-to-peek feel, so `onPointerEnter`/`onPointerLeave`
  // open/close the popover when the input is a mouse. Touch and pen taps fall
  // through to Popover's built-in click toggle.
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // Match `SessionHistoryMenu`'s button shell so the donut sits
          // visually on the same row of affordances inside PromptInputActions.
          aria-label={`Context window: ${pctRounded}% of ${formatTokens(window)}`}
          className="inline-flex items-center justify-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") setOpen(true);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setOpen(false);
          }}
        >
          <svg viewBox="0 0 24 24" className="size-5 -rotate-90 shrink-0" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r={DONUT_RADIUS}
              fill="none"
              className="stroke-muted-foreground/25"
              strokeWidth="3"
            />
            <circle
              cx="12"
              cy="12"
              r={DONUT_RADIUS}
              fill="none"
              className={cn("transition-all", progressColor)}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={DONUT_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        // Keep the popover open while the mouse is over its content (otherwise
        // hovering off the trigger into the popover would close it before the
        // user can read it). Touch users dismiss via tap-outside / Escape.
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setOpen(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setOpen(false);
        }}
        className="w-auto p-2"
        side="top"
        align="end"
      >
        <div className="space-y-0.5 text-xs">
          {usage ? (
            <>
              <div>Input: {usage.inputTokens.toLocaleString()}</div>
              <div>Output: {usage.outputTokens.toLocaleString()}</div>
              {usage.cacheReadTokens !== undefined && (
                <div>Cache read: {usage.cacheReadTokens.toLocaleString()}</div>
              )}
              {usage.cacheCreationTokens !== undefined && (
                <div>Cache write: {usage.cacheCreationTokens.toLocaleString()}</div>
              )}
              {usage.reasoningOutputTokens !== undefined && (
                <div>Reasoning output: {usage.reasoningOutputTokens.toLocaleString()}</div>
              )}
              {usage.totalProcessedTokens !== undefined &&
                usage.totalProcessedTokens > contextSize && (
                  <div>Total processed: {usage.totalProcessedTokens.toLocaleString()}</div>
                )}
              <div className="mt-1 border-t pt-1">
                Context: {contextSize.toLocaleString()} / {window.toLocaleString()} ({pctRounded}%)
              </div>
            </>
          ) : (
            <div>Context window: {window.toLocaleString()} tokens</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function usageContextSize(usage: UsageData | undefined): number {
  if (!usage) return 0;
  return usage.contextTokens ?? legacyContextSize(usage);
}

/**
 * Backward-compat fallback for usage snapshots that lack `contextTokens`.
 * Uses `provider` when set; falls back to `cacheCreationTokens` presence as
 * a Claude detector for snapshots persisted before the provider field
 * existed. Claude `inputTokens` excludes cached content (must add cache
 * fields); other providers report the full prompt.
 */
function legacyContextSize(usage: UsageData): number {
  const isClaude = usage.provider === "claude" || usage.cacheCreationTokens !== undefined;
  if (isClaude) {
    return (
      usage.inputTokens +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheCreationTokens ?? 0) +
      (usage.reasoningOutputTokens ?? 0)
    );
  }
  return usage.inputTokens + (usage.reasoningOutputTokens ?? 0);
}

interface SessionHistoryItem {
  sessionId: string;
  summary: string;
  lastModified: number;
  gitBranch?: string;
}

function SessionHistoryMenu({
  workspaceId,
  chatId,
  activeSessionId,
  onSelectSession,
  onNewSession,
}: {
  workspaceId: string;
  chatId: string;
  activeSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    trpc.sessions.list
      .query({ workspaceId, chatId })
      .then((data) => setSessions(data.sessions as SessionHistoryItem[]))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [open, workspaceId, chatId]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Clock className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Session history</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-72">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">No sessions yet</div>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {sessions.map((session) => {
              const isActive = session.sessionId === activeSessionId;
              return (
                <DropdownMenuItem
                  key={session.sessionId}
                  onClick={() => onSelectSession(session.sessionId)}
                  className={cn("flex flex-col items-start gap-0.5", isActive && "bg-accent")}
                >
                  <span className="line-clamp-1 text-sm font-medium">{session.summary}</span>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{relativeTime(session.lastModified)}</span>
                    {session.gitBranch && (
                      <>
                        <span className="text-border">·</span>
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="size-2.5" />
                          {session.gitBranch}
                        </span>
                      </>
                    )}
                  </div>
                </DropdownMenuItem>
              );
            })}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onNewSession()}>
          <Plus className="size-3.5" />
          New session
          <DropdownMenuShortcut>⌘⇧N</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QueuedMessageBubble({
  id,
  text,
  files,
  onCancel,
  onEdit,
}: {
  id: string;
  text: string;
  files?: QueuedFilePart[];
  onCancel: () => void;
  onEdit: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const sortableStyle = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  // When the dialog opens, reset the draft to the latest text. We don't
  // sync continuously so the user's in-progress edits aren't clobbered
  // if the queue subscription pushes an unchanged update mid-edit.
  const openEditor = useCallback(() => {
    setDraft(text);
    setEditing(true);
  }, [text]);

  const handleSave = useCallback(() => {
    const next = draft.trim();
    if (!next) return;
    if (next !== text) onEdit(next);
    setEditing(false);
  }, [draft, text, onEdit]);

  return (
    <>
      <div
        ref={setNodeRef}
        style={sortableStyle}
        className="group is-user flex w-full max-w-[90%] flex-col items-end ml-auto justify-end opacity-60"
      >
        <div className="flex min-w-0 max-w-full w-fit flex-col overflow-hidden rounded-md bg-secondary text-foreground">
          {/* Drag handle pinned to the top border — separate from the
              bubble body so click-to-edit doesn't conflict with reorder
              gestures. Acts as a visual "grip" rail across the top. */}
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label="Reorder queued message"
            className="flex w-full items-center justify-center border-b border-border/30 bg-muted/30 py-0.5 text-muted-foreground/60 cursor-grab touch-none transition-colors hover:bg-muted/50 hover:text-muted-foreground active:cursor-grabbing"
          >
            <GripHorizontal className="size-3.5" />
          </button>
          <div className="flex flex-col gap-2 break-words text-sm px-3 py-2">
            {files?.map((file, idx) => (
              <MessageFilePart key={`queued-file-${idx}`} part={{ type: "file", ...file }} />
            ))}
            <button
              type="button"
              onClick={openEditor}
              className="-mx-1 cursor-pointer rounded px-1 text-left transition-colors hover:bg-foreground/5"
              title="Click to edit"
            >
              <MessageResponse className="text-sm">{text}</MessageResponse>
            </button>
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
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Edit queued message</DialogTitle>
          </DialogHeader>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[120px] text-sm"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSave();
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!draft.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
