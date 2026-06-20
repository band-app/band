// useChat from @ai-sdk/react was removed as part of the chat-event-log
// refactor (issue #478). The chat is now driven by `useChatSubscription`
// reading the server's event log directly.
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
import { getToolName, isToolUIPart, type UIMessage } from "ai";
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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { AgentIcon, useExperimentalContextMeter } from "@/dashboard";
import { trpc } from "../lib/trpc-client";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import { FileLinkWorkspaceProvider } from "./ai-elements/file-link-components";
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
import { useChatSubscription } from "./chat/use-chat-subscription";
import { VirtualizedMessageList } from "./chat/VirtualizedMessageList";

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
    <div
      data-testid="chat-pane__thinking-indicator"
      className="mt-2 flex items-center gap-2 text-muted-foreground"
    >
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

interface QueuedFilePart {
  mediaType: string;
  url: string;
  filename?: string;
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
  /**
   * Background-notify path: fired from the subscription's reducer state
   * when the server resolves a session id on its own (first message in a
   * brand-new chat). Parent should refresh tab-title cache only — must
   * NOT remount this component, or the in-flight conversation gets torn
   * down. Server already persisted `chat.activeSessionId` via
   * task-service.session-start.
   */
  onSessionDiscovered?: (sessionId: string) => void;
  /**
   * User-initiated path: fired by "Select past session" and "New session"
   * affordances. Parent should persist + remount this component so its
   * subscription opens fresh against the new session's events.
   */
  onSwitchSession?: (sessionId: string | undefined) => Promise<void> | void;
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
  sessionQueryDone: _sessionQueryDone = false,
  showSessionList: _showSessionList,
  onShowSessionListChange,
  onStreamingChange,
  onNewSessionRef,
  onSessionDiscovered,
  onSwitchSession,
  chatKey: _chatKey = 0,
  agentType,
  codingAgentId,
  onSwitchAgent,
  visible,
  wsActive,
}: ChatViewProps) {
  // True once the user explicitly clears the session via "New session". The
  // parent's `initialSessionId` prop may stay stale for a tick or longer
  // after `handleNewSession` fires; we ignore it for skeleton/empty-state
  // decisions once cleared.
  const [initialSessionCleared, setInitialSessionCleared] = useState(false);
  const [contextMeterEnabled] = useExperimentalContextMeter();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stickyContextRef = useRef<StickToBottomContext>(null);
  const prevVisibleRef = useRef(visible);

  // Attach a stable `data-testid` to the StickToBottom scroll element so
  // integration tests can locate the scroller without walking up the DOM
  // from a child (which would couple the test to the use-stick-to-bottom
  // library's internal markup). `use-stick-to-bottom` doesn't expose a
  // prop for arbitrary attributes on the scroller — the JSX-prop path
  // that TEST-1 normally requires for `data-testid` is unreachable here
  // — so we set it once via the same `contextRef` we use for
  // programmatic scrolling. The imperative attach is intentional and
  // documented because the JSX path doesn't exist on this third-party
  // component; if `use-stick-to-bottom` adds a `scrollerProps` (or
  // similar) prop in a future release, switch back to the JSX form.
  // Empty deps because the attribute write is idempotent and only
  // needs to happen when the underlying DOM element is created — re-
  // firing on every render during streaming was needlessly busy.
  useEffect(() => {
    const el = stickyContextRef.current?.scrollRef?.current;
    if (el && !el.dataset.testid) {
      el.dataset.testid = "chat-pane__scroller";
    }
  }, []);

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
        // Since issue #520, `chats.update` returns 404 (not the previous
        // silent 200) when `chatId` no longer resolves — e.g. the user
        // deleted this chat in another tab between the local state
        // update and this fire-and-forget mutation. The 404 surfaces as
        // a TRPCClientError here; absorbing it keeps the UI from
        // surfacing a stale-chat error toast when the component is
        // already on its way out.
        .catch((err) => console.error("[ChatView] error persisting mode:", err));
    },
    [chatId],
  );
  useEffect(() => {
    trpc.modes.list
      .query({ agentId: codingAgentId || undefined })
      .then((data) => setModes(data.modes as { id: string; name: string; description?: string }[]))
      .catch(() => setModes([]));
    // Hydrate persisted mode from the chat record. The active-task mode
    // hint used to live here too; under the event-log model the running
    // task's mode arrives via the `task-started` event the subscription
    // delivers — the reducer doesn't expose it on `state` yet because the
    // mode-dropdown UI doesn't need it for any current code path. If the
    // dropdown needs to reflect mid-stream mode changes, surface it from
    // the reducer rather than re-introducing a side-channel probe.
    trpc.chats.get
      .query({ chatId })
      .then((data) => {
        const persisted = data.chat?.mode;
        if (typeof persisted === "string" && persisted) {
          setSelectedMode(persisted);
        }
      })
      .catch(() => {});
  }, [chatId, codingAgentId]);

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

  // (Legacy effect that dropped `maxContextTokens` from `usage` on model
  // switch lived here. Under the event-log model `usage` is owned by the
  // subscription reducer and the ContextMeter component handles the
  // model-switch fallback locally by treating `maxContextTokens` as a
  // hint, not a contract — see `ContextMeter` and `MODEL_CONTEXT_WINDOWS`
  // below.)

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
        // See `handleModeSelect` above — `chats.update` now 404s on a
        // stale chatId since #520. Absorbing the error keeps the
        // fire-and-forget UX intact.
        .catch((err) => console.error("[ChatView] error persisting model:", err));
    },
    [chatId],
  );

  // -----------------------------------------------------------------------
  // The new event-log subscription. One hook replaces:
  //   • useChat from @ai-sdk/react
  //   • TaskChatTransport
  //   • sessionIdRef + lastEventIdRef + firstEventIdRef + firstMessageIndexRef
  //   • connectAbortRef + statusRef
  //   • loadMessages + connectToRunningStream + the 5-step backoff retry
  //   • the focus/online listener
  //   • the wsActive deactivate/reactivate effect
  //   • the trpc.queue.stream subscription
  //   • optimistic queuedMessages state
  //   • the tasks.get pre-flight in handleSubmit
  //
  // Server is the single writer. The hook reads the event log and folds
  // it through `chatEventReducer`. See `docs/experiments/chat-event-log.md`.
  // -----------------------------------------------------------------------
  const subscription = useChatSubscription({
    workspaceId,
    chatId,
    mode: selectedMode,
    model: userModelOverride ?? agentDefaultModel,
    codingAgentId,
    // Mirrors the legacy wsActive lifecycle — release the connection
    // slot while the pane is not the active dockview tab; reopen on
    // reactivation (visibility / wsActive transitions). The hook also
    // factors in `document.visibilityState` internally.
    enabled: wsActive !== false,
  });
  const { messages, status, sessionId, queuedMessages, usage, send, cancel } = subscription;

  const isStreaming = status === "submitting" || status === "streaming";

  // Forward subscription-discovered session ids to the parent for tab-title
  // cache refresh. Uses the background path (`onSessionDiscovered`) — the
  // user-initiated path (`onSwitchSession`) is reserved for explicit "select
  // session" / "new session" actions and includes a remount.
  //
  // Seeded with `initialSessionId` so we don't re-fire for the value the
  // parent already gave us (which would happen on every remount after a
  // session switch).
  const lastNotifiedSessionRef = useRef<string | undefined>(initialSessionId);
  useEffect(() => {
    if (sessionId && lastNotifiedSessionRef.current !== sessionId) {
      lastNotifiedSessionRef.current = sessionId;
      onSessionDiscovered?.(sessionId);
    }
  }, [sessionId, onSessionDiscovered]);

  // Mirror legacy state shape for the queued-message render block + drag-drop.
  // `subscription.queuedMessages` is the server-pushed authoritative list,
  // but dnd-kit needs the local order to update immediately on drop
  // (otherwise items snap back). `optimisticQueue`, when non-null,
  // overrides the subscription's view until the next `queue-updated` event
  // lands — at which point we clear it and the server is authoritative again.
  type QueuedMessageView = { id: string; text: string; files?: QueuedFilePart[] };
  const [optimisticQueue, setOptimisticQueue] = useState<QueuedMessageView[] | null>(null);
  // Clear optimistic state on every subscription update — the server is
  // now the source of truth. If the user did rapid actions, the subscription
  // catches up within ms; the small reconciliation flicker is acceptable.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally watching `queuedMessages`
  useEffect(() => {
    setOptimisticQueue(null);
  }, [queuedMessages]);
  const queuedMessagesView: QueuedMessageView[] = optimisticQueue ?? queuedMessages;

  // The current session this view is on.
  //
  // Once the user clicks "New session", `initialSessionCleared` is set to
  // `true` and we MUST treat the chat as session-less regardless of what
  // the subscription's `sessionId` reports. Without this, the still-open
  // (pre-remount) subscription's `sessionId` keeps the chat looking like
  // it's on the old session — the "session history" tab title stays, and
  // the skeleton stays mounted via the `!!currentSessionId` branch of the
  // skeleton condition below.
  //
  // Otherwise, the subscription's `sessionId` is authoritative once a
  // `session-resolved` event has arrived; before that, fall back to
  // `initialSessionId` (the parent's cached value from `chats.get`).
  const currentSessionId = initialSessionCleared ? undefined : (sessionId ?? initialSessionId);

  // Drop the SDK-reported `maxContextTokens` already covered by the hook
  // via reducer state — handled below where `usage` is consumed.

  // No older-messages pagination on the first cut. The subscription's
  // initial replay loads the recent window from the buffer + JSONL.
  // Scroll-up pagination can be added back as a follow-up by paginating
  // the chat-events subscription with `Last-Event-ID` from below the
  // current replay window — see `docs/experiments/chat-event-log.md`.
  const hasMore = false;
  const loadingHistory =
    !isStreaming && messages.length === 0 && !!initialSessionId && !subscription.isConnected;
  const loadingOlder = false;

  const handleStop = useCallback(() => {
    void cancel();
  }, [cancel]);

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  const handleEscape = useCallback(() => {
    if (isStreaming) {
      handleStop();
    }
  }, [isStreaming, handleStop]);

  // Session switching — handled by the parent (`ChatPane.onSwitchSession`)
  // which persists to the server and bumps `paneKey` to remount this
  // component with a clean reducer state. The new subscription opens
  // against the new session's events.
  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      // Clear the server-side queue: queued messages were enqueued against
      // the previous session; carrying them over isn't well-defined.
      trpc.queue.clear.mutate({ workspaceId, chatId }).catch(() => {});
      onShowSessionListChange(false);
      await onSwitchSession?.(sessionId);
    },
    [onSwitchSession, onShowSessionListChange, workspaceId, chatId],
  );

  const handleNewSession = useCallback(() => {
    setInitialSessionCleared(true);
    trpc.queue.clear.mutate({ workspaceId, chatId }).catch(() => {});
    onShowSessionListChange(false);
    void onSwitchSession?.(undefined);
  }, [onSwitchSession, onShowSessionListChange, workspaceId, chatId]);

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

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (!message.text.trim() && !message.files?.length) return;
      // No pre-flight, no optimistic state, no `isStreaming` branch. The
      // server queues server-side if a task is already running; the
      // resulting `queue-updated` event lands on the subscription within
      // ms. The legacy `handleSubmit` had four conditional branches
      // (queue if streaming locally, probe tasks.get and queue if running
      // remotely, send otherwise, fall through to send if probe failed) —
      // all of them collapse into this one call.
      try {
        await send(message.text, message.files);
      } catch (err) {
        console.error("[ChatView] send failed:", err);
      }
    },
    [send],
  );

  const handleCancelQueued = useCallback(
    (id: string) => {
      // Optimistic update — subscription's queue-updated event clears
      // optimisticQueue and replaces with server state.
      setOptimisticQueue((current) => (current ?? queuedMessages).filter((m) => m.id !== id));
      trpc.queue.remove.mutate({ workspaceId, chatId, id }).catch(() => {});
    },
    [queuedMessages, workspaceId, chatId],
  );

  const handleEditQueued = useCallback(
    (id: string, text: string) => {
      setOptimisticQueue((current) =>
        (current ?? queuedMessages).map((m) => (m.id === id ? { ...m, text } : m)),
      );
      trpc.queue.update.mutate({ workspaceId, chatId, id, text }).catch(() => {});
    },
    [queuedMessages, workspaceId, chatId],
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
      const base = optimisticQueue ?? queuedMessages;
      const oldIdx = base.findIndex((m) => m.id === active.id);
      const newIdx = base.findIndex((m) => m.id === over.id);
      if (oldIdx === -1 || newIdx === -1) return;
      const reordered = arrayMove(base, oldIdx, newIdx);
      setOptimisticQueue(reordered);
      // Persist the new order. queue.set replaces the whole queue;
      // the subscription broadcasts the same shape back which clears the
      // optimistic state.
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
    },
    [optimisticQueue, queuedMessages, workspaceId, chatId],
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

  // Stable identity for the virtualizer's `getItemKey` — without this,
  // every `ChatView` render creates a fresh arrow function whose
  // identity flips the `useVirtualizer` memoization keys, causing
  // `getMeasurements()` to re-walk the full message count per render.
  // At a fast-streaming agent (~30 text-delta events/s × N messages
  // each), the saved per-second work scales linearly with conversation
  // length. The `renderItem` closure below captures `messages` and
  // `isStreaming` so its identity necessarily changes per delta — that
  // path can't be memoised the same way without recomputing on every
  // change anyway, so we leave it inline.
  const getMessageKey = useCallback((message: UIMessage) => message.id, []);

  const getLastUserMessage = useCallback((): string | undefined => {
    // Under the chat-events model, queued/drained user messages emit their
    // own user-role messages — no need to scan assistant parts for
    // `data-prompt` markers (that legacy AI-SDK chunk type is gone).
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      const text = messages[i].parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return undefined;
  }, [messages]);

  return (
    // Scope every `band-file:` link clicked inside this chat to *this*
    // workspace — `dispatchOpenFile` reads the id from context, so a
    // dockview that has both workspace A and workspace B alive at once
    // (LRU cache) routes each click to the chat's owning workspace rather
    // than racing every mounted layout against the active tab. Without
    // this, a click in workspace A's chat would open the file in
    // whichever workspace happens to be active when the listener fires
    // (issue #539).
    <FileLinkWorkspaceProvider workspaceId={workspaceId}>
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
            Skeleton / empty-state decision (issue #478, simplified):
            The ONLY signal that determines "we're still loading vs. done
            loading" is whether the EventSource is connected. Everything
            else (initialSessionId, initialSessionCleared, currentSessionId,
            sessionQueryDone) ends up racy across the
            setInitialSessionId / setPaneKey batched updates fired by
            `New session` and `Select session`, and the skeleton would
            get stuck whenever those races resolved in the wrong order.

            - Not connected yet → skeleton (we don't know what's coming).
            - Connected + no messages → empty state (server told us
              nothing's there, or we just cleared the session).
            - Connected + messages → render them.

            JSONL replay events arrive over the same SSE response that
            flips `isConnected` to true, so the gap between "connected
            with empty messages" and "messages populate" is sub-frame in
            practice — empty-state flash is imperceptible.
          */}
            {messages.length === 0 && !subscription.isConnected && <ConversationSkeleton />}

            {messages.length === 0 && subscription.isConnected && (
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

            {messages.length > 0 && (
              <VirtualizedMessageList
                items={messages}
                getKey={getMessageKey}
                renderItem={(message, messageIndex) => {
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
                      <Message from="user">
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

                  // Assistant message — under the chat-events model every queued
                  // turn becomes its own user-role message, so we never need to
                  // split an assistant message at `data-prompt` boundaries.
                  const visibleParts = message.parts.filter(
                    (p) =>
                      (p.type === "text" && p.text.trim()) || p.type === "file" || isToolUIPart(p),
                  );
                  if (visibleParts.length === 0 && !showThinking) return null;
                  return (
                    <Message from="assistant">
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
                }}
              />
            )}
            {isStreaming && (!messages.length || messages[messages.length - 1].role === "user") && (
              <Message from="assistant">
                <MessageContent>
                  <ThinkingIndicator />
                </MessageContent>
              </Message>
            )}
            {queuedMessagesView.length > 0 && (
              <DndContext
                sensors={dndSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleReorderQueued}
              >
                <SortableContext
                  items={queuedMessagesView.map((m) => m.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {queuedMessagesView.map((m) => (
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
                    activeSessionId={currentSessionId}
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
                    disabled={isStreaming}
                  />
                )}
                {modes.length > 0 && (
                  <ModeMenu modes={modes} selected={selectedMode} onSelect={handleModeSelect} />
                )}
              </div>
              {/* PromptInputSubmit was built against the AI SDK's ChatStatus
                union (`"ready" | "submitted" | "streaming" | "error"`).
                Our reducer's ChatStatus is the same shape under different
                names; map at the boundary. */}
              <PromptInputSubmit
                status={
                  status === "submitting"
                    ? "submitted"
                    : status === "idle" || status === "completed"
                      ? "ready"
                      : status
                }
                onStop={handleStop}
              />
            </PromptInputActions>
          </PromptInput>
        </div>
      </div>
    </FileLinkWorkspaceProvider>
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

  // Composing Tooltip + DropdownMenu trigger:
  //
  //   <Tooltip><TooltipTrigger asChild><DropdownMenuTrigger className="…">
  //
  // i.e. only ONE `asChild` in the chain. The previous shape was:
  //
  //   <TooltipTrigger asChild><DropdownMenuTrigger asChild><button>…
  //
  // Two stacked `asChild` triggers fight over the underlying button's ref:
  // Radix's `composeRefs` works pairwise but the outer `asChild` ends up
  // capturing the inner `DropdownMenuTrigger` (a forwardRef component) as
  // the anchor *element* rather than the actual `<button>`. The Popper
  // then can't find an anchor on first open and falls back to positioning
  // against the document body — visually that's the dropdown sitting in
  // the top-left of the chat with a 100+ px gap from the Clock icon
  // trigger. Removing the inner `asChild` lets DropdownMenuTrigger render
  // its own `<button>`, the tooltip wraps it cleanly, and Popper anchors
  // correctly every time. Same fix kills the click-leak: with a correct
  // anchor the menu opens ABOVE the trigger (via `side="top"`) instead
  // of underneath the cursor.
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            type="button"
            data-testid="chat-pane__session-history-button"
            aria-label="Session history"
            className="inline-flex items-center justify-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Clock className="size-4" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Session history</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-72">
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
                  onSelect={() => onSelectSession(session.sessionId)}
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
        <DropdownMenuItem onSelect={() => onNewSession()}>
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
            {files?.map((file) => (
              <MessageFilePart key={`queued-file-${file.url}`} part={{ type: "file", ...file }} />
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
