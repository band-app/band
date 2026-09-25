// The chat pane (issue #648): renders one chat's ACP event log. Messages,
// session settings and requests all come from `useChatSubscription`, which
// folds the server's event stream through `transcriptReducer`.
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
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
import {
  Bot,
  Brain,
  ChevronDown,
  Clock,
  CodeXml,
  GripHorizontal,
  Loader2,
  Plus,
  ScrollText,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { AgentIcon, useExperimentalContextMeter } from "@/dashboard";
import { trpc } from "../lib/trpc-client";
import type { SessionState } from "../shared/chat-events";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import { ElicitationForm } from "./ai-elements/elicitation-form";
import { FileLinkWorkspaceProvider } from "./ai-elements/file-link-components";
import { FileMentionSuggestions } from "./ai-elements/file-mention-suggestions";
import { Message, MessageContent, MessageFilePart, MessageResponse } from "./ai-elements/message";
import { PermissionRequest } from "./ai-elements/permission-request";
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
import { ToolCall } from "./ai-elements/tool-call";
import type { ChatMessage, Entry } from "./chat/transcript";
import { useChatSubscription } from "./chat/use-chat-subscription";
import { VirtualizedMessageList } from "./chat/VirtualizedMessageList";

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
  // Skeleton bubbles override the role-scoped `data-testid` that
  // `Message` stamps by default — locators like
  // `chatPane.userMessage(text)` should target REAL message bubbles
  // only, never the loading-state placeholders.
  return (
    <output
      className="flex animate-pulse flex-col gap-6"
      aria-busy="true"
      aria-label="Loading messages"
    >
      <Message from="user" data-testid={undefined}>
        <MessageContent>
          <div className="flex flex-col gap-2 py-1">
            <SkeletonBar widthClass="w-48" className="bg-foreground/10" />
            <SkeletonBar widthClass="w-32" className="bg-foreground/10" />
          </div>
        </MessageContent>
      </Message>
      <Message from="assistant" data-testid={undefined}>
        <MessageContent>
          <div className="flex flex-col gap-2 pt-1">
            <SkeletonBar widthClass="w-3/4" />
            <SkeletonBar widthClass="w-full" />
            <SkeletonBar widthClass="w-5/6" />
            <SkeletonBar widthClass="w-2/3" />
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

interface Choice {
  id: string;
  name: string;
  description?: string;
}

type SelectOption = Extract<SessionConfigOption, { type: "select" }>;

function selectChoices(option: SelectOption): Choice[] {
  return option.options
    .flatMap((o) => ("group" in o ? o.options : [o]))
    .map((o) => ({ id: o.value, name: o.name, description: o.description ?? undefined }));
}

function findSelect(session: SessionState | null, category: "model" | "mode") {
  return session?.configOptions.find(
    (o): o is SelectOption => o.type === "select" && (o.category === category || o.id === category),
  );
}

/**
 * The model and mode pickers read ACP session config options (category
 * `model` / `mode`). Agents without them expose the legacy model and mode
 * state instead; `__legacy_model` / `__legacy_mode` tell the server to use
 * `session/set_model` / `session/set_mode`.
 */
function sessionPickers(session: SessionState | null) {
  const modelOption = findSelect(session, "model");
  const modeOption = findSelect(session, "mode");
  const models: Choice[] = modelOption
    ? selectChoices(modelOption)
    : (session?.models?.availableModels ?? []).map((m) => ({
        id: m.modelId,
        name: m.name,
        description: m.description ?? undefined,
      }));
  const modes: Choice[] = modeOption
    ? selectChoices(modeOption)
    : (session?.modes?.availableModes ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? undefined,
      }));
  return {
    models,
    model: modelOption ? String(modelOption.currentValue) : session?.models?.currentModelId,
    modelConfigId: modelOption?.id ?? "__legacy_model",
    modes,
    mode: modeOption ? String(modeOption.currentValue) : session?.modes?.currentModeId,
    modeConfigId: modeOption?.id ?? "__legacy_mode",
    // Everything else the agent lets the user choose (reasoning effort, …).
    others: (session?.configOptions ?? []).filter(
      (o): o is SelectOption => o.type === "select" && o !== modelOption && o !== modeOption,
    ),
  };
}

interface ChatViewProps {
  workspaceId: string;
  chatId: string;
  workspaceName: string;
  initialSessionId?: string;
  onShowSessionListChange: (show: boolean) => void;
  onStreamingChange?: (streaming: boolean) => void;
  onNewSessionRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * Background-notify path: the chat attached to a session on its own
   * (first message in a new chat). The parent refreshes its tab-title
   * cache only; it must NOT remount this component.
   */
  onSessionDiscovered?: (sessionId: string) => void;
  /**
   * User-initiated path: "Select past session" and "New session". The
   * parent persists the choice and remounts this component so its
   * subscription opens against the new session.
   */
  onSwitchSession?: (sessionId: string | undefined, summary?: string) => Promise<void> | void;
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
  initialSessionId,
  onShowSessionListChange,
  onStreamingChange,
  onNewSessionRef,
  onSessionDiscovered,
  onSwitchSession,
  agentType,
  codingAgentId,
  onSwitchAgent,
  visible,
  wsActive,
}: ChatViewProps) {
  // True once the user clicks "New session": the still-open subscription
  // keeps reporting the old session until the parent remounts us.
  const [initialSessionCleared, setInitialSessionCleared] = useState(false);
  const [contextMeterEnabled] = useExperimentalContextMeter();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stickyContextRef = useRef<StickToBottomContext>(null);
  const prevVisibleRef = useRef(visible);
  // Resolved StickToBottom scroll element, surfaced as state so the
  // scroll-back IntersectionObserver effect re-runs once it's available.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  // Attach a stable `data-testid` to the StickToBottom scroll element.
  // `use-stick-to-bottom` renders the scroller itself with no attribute
  // pass-through, and populates its ref after the first commit, so retry
  // for a few frames.
  useEffect(() => {
    let raf = 0;
    let attempts = 0;
    const attach = () => {
      attempts += 1;
      const el = stickyContextRef.current?.scrollRef?.current;
      if (el) {
        if (!el.dataset.testid) el.dataset.testid = "chat-pane__scroller";
        setScrollEl(el);
        return;
      }
      if (attempts >= 10) return;
      raf = requestAnimationFrame(attach);
    };
    attach();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Scroll to bottom when the panel becomes visible again: while hidden the
  // container had no height, so StickToBottom couldn't track position.
  useEffect(() => {
    const wasHidden = prevVisibleRef.current === false;
    prevVisibleRef.current = visible;
    if (!wasHidden || !visible) return;
    const scrollToEnd = () => {
      stickyContextRef.current?.scrollToBottom?.("instant");
      const el = stickyContextRef.current?.scrollRef?.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    requestAnimationFrame(() => {
      scrollToEnd();
      setTimeout(scrollToEnd, 50);
    });
  }, [visible]);

  const subscription = useChatSubscription({
    workspaceId,
    chatId,
    codingAgentId,
    // Release the connection while the pane isn't the active tab.
    enabled: wsActive !== false,
  });
  const {
    messages,
    status,
    sessionId,
    queue,
    session,
    plan,
    send,
    cancel,
    loadOlder,
    answerPermission,
    answerElicitation,
    setConfigOption,
  } = subscription;
  const isStreaming = status === "submitting" || status === "streaming";

  // Session settings from the ACP session (or the agent catalog before the
  // chat has one).
  const pickers = useMemo(() => sessionPickers(session), [session]);
  const skills = useMemo(
    () =>
      (session?.commands ?? []).map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.input && "hint" in c.input ? c.input.hint : undefined,
      })),
    [session?.commands],
  );

  const handleConfig = useCallback(
    (configId: string, value: string) => {
      setConfigOption(configId, value).catch((err) =>
        console.error("[ChatView] error setting session option:", err),
      );
    },
    [setConfigOption],
  );
  const handleModelSelect = useCallback(
    (model: string | undefined) => {
      if (model) handleConfig(pickers.modelConfigId, model);
    },
    [handleConfig, pickers.modelConfigId],
  );
  const handleModeSelect = useCallback(
    (mode: string | undefined) => {
      if (mode) handleConfig(pickers.modeConfigId, mode);
    },
    [handleConfig, pickers.modeConfigId],
  );

  // Shift+Tab cycles modes (dispatched from the workspace layout too).
  useEffect(() => {
    const handler = () => {
      const { modes, mode } = pickers;
      if (modes.length < 2) return;
      const current = modes.findIndex((m) => m.id === mode);
      handleModeSelect(modes[(current + 1) % modes.length].id);
    };
    window.addEventListener("band:toggle-mode", handler);
    return () => window.removeEventListener("band:toggle-mode", handler);
  }, [pickers, handleModeSelect]);

  // Other agents' cached models, for switching agent from the model menu.
  const [agentGroups, setAgentGroups] = useState<AgentGroup[]>([]);
  useEffect(() => {
    trpc.models.listAll
      .query()
      .then((data) => setAgentGroups(data.agents as AgentGroup[]))
      .catch(() => setAgentGroups([]));
  }, []);
  const menuGroups = useMemo(
    () =>
      agentGroups.map((g) =>
        g.agentId === codingAgentId && pickers.models.length > 0
          ? { ...g, models: pickers.models }
          : g,
      ),
    [agentGroups, codingAgentId, pickers.models],
  );

  // Forward a session the chat attached to on its own to the parent, for
  // the tab title. Seeded with `initialSessionId` so a remount doesn't
  // re-fire for the session the parent already knows.
  const lastNotifiedSessionRef = useRef<string | undefined>(initialSessionId);
  useEffect(() => {
    if (sessionId && lastNotifiedSessionRef.current !== sessionId) {
      lastNotifiedSessionRef.current = sessionId;
      onSessionDiscovered?.(sessionId);
    }
  }, [sessionId, onSessionDiscovered]);

  // Queue view with drag-reorder. `optimisticQueue` holds the local order
  // until the server's next `queue-updated` confirms it.
  type QueuedMessageView = { id: string; text: string; files?: QueuedFilePart[] };
  const [optimisticQueue, setOptimisticQueue] = useState<QueuedMessageView[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally watching `queue`
  useEffect(() => {
    setOptimisticQueue(null);
  }, [queue]);
  const queuedMessagesView: QueuedMessageView[] = optimisticQueue ?? queue;

  const currentSessionId = initialSessionCleared ? undefined : (sessionId ?? initialSessionId);

  const hasMore = subscription.hasOlder;
  const loadingHistory = !isStreaming && messages.length === 0 && !subscription.isConnected;
  const loadingOlder = subscription.loadingOlder;

  const handleStop = useCallback(() => {
    void cancel();
  }, [cancel]);

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  const handleEscape = useCallback(() => {
    if (isStreaming) handleStop();
  }, [isStreaming, handleStop]);

  // Session switching is handled by the parent, which persists the choice
  // and remounts this component with a fresh subscription.
  const handleSelectSession = useCallback(
    async (nextSessionId: string, summary?: string) => {
      // Queued messages belong to the session they were queued against.
      trpc.queue.clear.mutate({ workspaceId, chatId }).catch(() => {});
      onShowSessionListChange(false);
      await onSwitchSession?.(nextSessionId, summary);
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
    if (onNewSessionRef) onNewSessionRef.current = handleNewSession;
    return () => {
      if (onNewSessionRef) onNewSessionRef.current = null;
    };
  }, [onNewSessionRef, handleNewSession]);

  // Cmd/Ctrl+Shift+N starts a new session in the visible chat pane.
  useEffect(() => {
    if (!visible || !wsActive) return;
    const onNewChat = () => handleNewSession();
    window.addEventListener("band:new-chat-session", onNewChat);
    return () => window.removeEventListener("band:new-chat-session", onNewChat);
  }, [visible, wsActive, handleNewSession]);

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (!message.text.trim() && !message.files?.length) return;
      // The server queues the message when a turn is already running.
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
      setOptimisticQueue((current) => (current ?? queue).filter((m) => m.id !== id));
      trpc.queue.remove.mutate({ workspaceId, chatId, id }).catch(() => {});
    },
    [queue, workspaceId, chatId],
  );

  const handleEditQueued = useCallback(
    (id: string, text: string) => {
      setOptimisticQueue((current) =>
        (current ?? queue).map((m) => (m.id === id ? { ...m, text } : m)),
      );
      trpc.queue.update.mutate({ workspaceId, chatId, id, text }).catch(() => {});
    },
    [queue, workspaceId, chatId],
  );

  // A small activation distance so a click doesn't start a drag.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleReorderQueued = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const base = optimisticQueue ?? queue;
      const oldIdx = base.findIndex((m) => m.id === active.id);
      const newIdx = base.findIndex((m) => m.id === over.id);
      if (oldIdx === -1 || newIdx === -1) return;
      const reordered = arrayMove(base, oldIdx, newIdx);
      setOptimisticQueue(reordered);
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
    [optimisticQueue, queue, workspaceId, chatId],
  );

  // Stable identity for the virtualizer's `getItemKey`.
  const getMessageKey = useCallback((message: ChatMessage) => message.id, []);

  // `messages` changes on every streamed chunk; read it through a ref so the
  // row renderer keeps its identity and windowed rows keep their memo.
  // `isStreaming` stays a real dependency: it flips only at turn start and
  // end, and the last row's thinking indicator must see that flip.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const actionsRef = useRef({ answerPermission, answerElicitation });
  actionsRef.current = { answerPermission, answerElicitation };

  // Entrance animation only for messages appended at the end after the
  // first render; loaded history and prepended pages render instantly.
  const seenMessageIdsRef = useRef<Set<string> | null>(null);
  const enteringIdsRef = useRef<Set<string>>(new Set());

  // Scroll-back pagination: fetch older turns when the top sentinel shows.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !scrollEl || !hasMore || loadingHistory) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) void loadOlder();
        }
      },
      { root: scrollEl, rootMargin: "150px 0px 0px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollEl, hasMore, loadingHistory, loadOlder]);

  const renderEntry = useCallback((entry: Entry) => {
    switch (entry.kind) {
      case "text":
        return entry.text.trim() ? (
          <MessageResponse key={entry.id}>{entry.text}</MessageResponse>
        ) : null;
      case "thought":
        return (
          <details key={entry.id} className="group/thought text-muted-foreground">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs">
              <Brain className="size-3.5" />
              Thinking
            </summary>
            <div className="mt-1 whitespace-pre-wrap border-l-2 border-border/50 pl-3 text-xs">
              {entry.text}
            </div>
          </details>
        );
      case "tool":
        return <ToolCall key={entry.id} entry={entry} />;
      case "permission":
        return (
          <PermissionRequest
            key={entry.id}
            entry={entry}
            onAnswer={(optionId) => actionsRef.current.answerPermission(entry.id, optionId)}
          />
        );
      case "elicitation":
        return (
          <ElicitationForm
            key={entry.id}
            entry={entry}
            onAnswer={(action, content) =>
              actionsRef.current.answerElicitation(entry.id, action, content)
            }
          />
        );
      case "file":
        return <MessageFilePart key={entry.id} part={{ type: "file", ...entry.file }} />;
      case "notice":
        return (
          <div
            key={entry.id}
            data-testid="chat-pane__notice"
            data-level={entry.level}
            className={cn(
              "text-sm",
              entry.level === "error" && "text-destructive",
              entry.level === "warning" && "text-amber-600 dark:text-amber-400",
              entry.level === "info" && "text-muted-foreground",
            )}
          >
            {entry.text}
          </div>
        );
    }
  }, []);

  const renderMessageItem = useCallback(
    (message: ChatMessage, messageIndex: number) => {
      const currentMessages = messagesRef.current;
      const isLastMessage = messageIndex === currentMessages.length - 1;

      const seen = seenMessageIdsRef.current;
      let entering = false;
      if (seen === null) {
        seenMessageIdsRef.current = new Set(currentMessages.map((m) => m.id));
      } else if (!seen.has(message.id)) {
        seen.add(message.id);
        if (messageIndex >= currentMessages.length - 2) {
          entering = true;
          enteringIdsRef.current.add(message.id);
          window.setTimeout(() => enteringIdsRef.current.delete(message.id), 400);
        }
      } else if (enteringIdsRef.current.has(message.id)) {
        entering = true;
      }

      if (message.role === "user") {
        return (
          <Message
            from="user"
            className={cn(entering && "chat-message-enter", message.pending && "opacity-80")}
          >
            <MessageContent>
              {message.files?.map((file) => (
                <MessageFilePart key={file.url} part={{ type: "file", ...file }} />
              ))}
              {message.text.trim() && <MessageResponse>{message.text}</MessageResponse>}
            </MessageContent>
          </Message>
        );
      }

      // The agent waiting on the user isn't "thinking".
      const waiting = message.entries.some(
        (e) => (e.kind === "permission" || e.kind === "elicitation") && !e.answer,
      );
      const showThinking = isLastMessage && isStreaming && !waiting;
      if (message.entries.length === 0 && !showThinking) return null;
      return (
        <Message from="assistant" className={entering ? "chat-message-enter" : undefined}>
          <MessageContent>
            {message.entries.map(renderEntry)}
            {showThinking && <ThinkingIndicator />}
          </MessageContent>
        </Message>
      );
    },
    [isStreaming, renderEntry],
  );

  const getLastUserMessage = useCallback((): string | undefined => {
    const current = messagesRef.current;
    for (let i = current.length - 1; i >= 0; i--) {
      const m = current[i];
      if (m.role === "user" && m.text.trim()) return m.text.trim();
    }
    return undefined;
  }, []);

  return (
    // Scope every `band-file:` link clicked inside this chat to *this*
    // workspace (issue #539).
    <FileLinkWorkspaceProvider workspaceId={workspaceId}>
      <div className="flex min-h-0 flex-1 flex-col">
        <Conversation className="min-h-0 flex-1" contextRef={stickyContextRef}>
          {/* Absolutely positioned so it never shifts content while an older
              page loads (issue #572). */}
          {loadingOlder && (
            <output
              className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
              aria-busy="true"
              aria-label="Loading older messages"
              data-testid="chat-pane__loading-older"
            >
              <span className="flex items-center gap-2 rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">
                <Loader2 className="size-3.5 animate-spin" />
                Loading earlier messages…
              </span>
            </output>
          )}
          <ConversationContent>
            {hasMore && !loadingHistory && (
              <div ref={sentinelRef} className="h-px w-full shrink-0" aria-hidden="true" />
            )}

            {/* Not connected yet → skeleton. Connected with nothing → empty
                state. The replay arrives on the same response that flips
                `isConnected`, so the gap is sub-frame. */}
            {messages.length === 0 && !subscription.isConnected && <ConversationSkeleton />}

            {messages.length === 0 && subscription.isConnected && (
              <ConversationEmptyState
                data-testid="chat-pane__empty-state"
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
                renderItem={renderMessageItem}
              />
            )}
            {isStreaming && (!messages.length || messages[messages.length - 1].role === "user") && (
              // No assistant-message testid on the standalone placeholder.
              <Message from="assistant" data-testid={undefined}>
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
          <TaskListWidget plan={plan} workspaceId={workspaceId} />
          <PromptInput
            onSubmit={handleSubmit}
            draftKey={workspaceId}
            visible={visible}
            wsActive={wsActive}
            workspaceId={workspaceId}
            chatId={chatId}
          >
            <SlashCommandSuggestions skills={skills} />
            <FileMentionSuggestions workspaceId={workspaceId} />
            <PromptInputTextarea
              placeholder="Type a message..."
              onEscape={handleEscape}
              onPreviousMessage={getLastUserMessage}
              onShiftTab={() => window.dispatchEvent(new CustomEvent("band:toggle-mode"))}
            />
            <PromptInputActions>
              <div className="flex items-center gap-0.5">
                <PromptInputAttach />
                {(session?.canListSessions ?? true) && (
                  <SessionHistoryMenu
                    workspaceId={workspaceId}
                    chatId={chatId}
                    activeSessionId={currentSessionId}
                    onSelectSession={handleSelectSession}
                    onNewSession={handleNewSession}
                  />
                )}
                {contextMeterEnabled && (
                  <ContextMeter usage={session?.usage ?? null} costUsd={session?.costUsd ?? null} />
                )}
                {(menuGroups.length > 0 || pickers.models.length > 0) && (
                  <AgentModelMenu
                    agentGroups={
                      menuGroups.length > 0
                        ? menuGroups
                        : [
                            {
                              agentId: codingAgentId ?? "",
                              agentType: agentType ?? "",
                              agentLabel: "",
                              models: pickers.models,
                            },
                          ]
                    }
                    currentAgentId={codingAgentId}
                    currentAgentType={agentType}
                    selectedModel={pickers.model}
                    onSelectModel={handleModelSelect}
                    onSwitchAgent={onSwitchAgent}
                    disabled={isStreaming}
                  />
                )}
                {pickers.modes.length > 0 && (
                  <ModeMenu
                    modes={pickers.modes}
                    selected={pickers.mode}
                    onSelect={handleModeSelect}
                  />
                )}
                {pickers.others.map((option) => (
                  <ConfigOptionMenu
                    key={option.id}
                    option={option}
                    onSelect={(value) => handleConfig(option.id, value)}
                  />
                ))}
              </div>
              <PromptInputSubmit
                status={
                  status === "submitting" ? "submitted" : status === "idle" ? "ready" : status
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

/** A select-type session config option other than model and mode, such as
 *  reasoning effort. */
function ConfigOptionMenu({
  option,
  onSelect,
}: {
  option: SelectOption;
  onSelect: (value: string) => void;
}) {
  const choices = selectChoices(option);
  const current = choices.find((c) => c.id === option.currentValue);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={`chat-pane__config-option--${option.id}`}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <SlidersHorizontal className="size-3" />
          {current?.name ?? option.name}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        <DropdownMenuLabel>{option.name}</DropdownMenuLabel>
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.id}
            onClick={() => onSelect(choice.id)}
            className={cn(
              "flex flex-col items-start gap-0.5",
              choice.id === option.currentValue && "bg-accent",
            )}
          >
            <span className="text-sm font-medium">{choice.name}</span>
            {choice.description && (
              <span className="text-xs text-muted-foreground">{choice.description}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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

/**
 * Context-window pressure from the agent's ACP `usage_update` (tokens in
 * context out of the window size), plus the session's cost: the agent's
 * own figure, or Band's estimate from token counts for agents that report
 * none.
 */
function ContextMeter({
  usage,
  costUsd,
}: {
  usage: SessionState["usage"];
  costUsd: number | null;
}) {
  const pct = usage && usage.size > 0 ? Math.min(100, (usage.used / usage.size) * 100) : 0;
  const pctRounded = Math.round(pct);
  const danger = pct >= 85;
  const warn = !danger && pct >= 65;
  // Monochrome: the donut is a quiet status glyph among the other muted
  // affordances. Higher usage = darker shade.
  const progressColor = danger
    ? "stroke-foreground"
    : warn
      ? "stroke-muted-foreground"
      : "stroke-muted-foreground/60";
  const dashOffset = pct <= 0 ? DONUT_CIRCUMFERENCE : DONUT_CIRCUMFERENCE * (1 - pct / 100);
  // Controlled popover: hover-to-peek with a mouse, tap on touch devices.
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chat-pane__context-meter"
          aria-label={
            usage
              ? `Context window: ${pctRounded}% of ${formatTokens(usage.size)}`
              : "Context window: no usage yet"
          }
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
              className={cn("transition-[stroke-dashoffset,stroke]", progressColor)}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={DONUT_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
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
            <div>
              Context: {usage.used.toLocaleString()} / {usage.size.toLocaleString()} ({pctRounded}%)
            </div>
          ) : (
            <div>No usage reported yet</div>
          )}
          {costUsd !== null && <div>Cost: ${costUsd.toFixed(costUsd < 1 ? 3 : 2)}</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface SessionHistoryItem {
  sessionId: string;
  summary: string;
  lastModified: number;
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
  onSelectSession: (sessionId: string, summary: string) => void;
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
          <div
            data-testid="chat-pane__session-history-empty"
            className="px-3 py-4 text-center text-sm text-muted-foreground"
          >
            No sessions yet
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {sessions.map((session) => {
              const isActive = session.sessionId === activeSessionId;
              return (
                <DropdownMenuItem
                  key={session.sessionId}
                  onSelect={() => onSelectSession(session.sessionId, session.summary)}
                  className={cn("flex flex-col items-start gap-0.5", isActive && "bg-accent")}
                >
                  <span className="line-clamp-1 text-sm font-medium">{session.summary}</span>
                  <span className="text-xs text-muted-foreground">
                    {session.lastModified ? relativeTime(session.lastModified) : ""}
                  </span>
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
