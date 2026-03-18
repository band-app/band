import { useChat } from "@ai-sdk/react";
import { Badge } from "@band/ui";
import { getToolName, isToolUIPart } from "ai";
import { Bot, Clock, Loader2, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TaskChatTransport } from "../lib/task-chat-transport";
import { trpc } from "../lib/trpc-client";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation";
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
  return {
    toolCallId: part.toolCallId,
    toolName,
    input: part.input,
    output: part.output,
    errorText: part.errorText,
    isError: ERROR_STATES.has(part.state),
    isInProgress: IN_PROGRESS_STATES.has(part.state),
    // AskUserQuestion uses toolCallId as the approval key since the
    // canUseTool callback in the agent adapter manages the pending-input
    // lifecycle directly (not through the AI SDK approval mechanism).
    approvalId: toolName === "AskUserQuestion" ? part.toolCallId : approval?.id,
  };
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Loader2 className="size-4 lg:size-3.5 animate-spin" />
      <span className="text-base lg:text-sm">Thinking...</span>
    </div>
  );
}

interface HistoryMessageContent {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}

interface HistoryMessage {
  role: "user" | "assistant";
  id: string;
  content: HistoryMessageContent[];
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
 * When `skipFirstPrompt` is true, the first `data-prompt` is not turned into
 * a user bubble (because a real user message already precedes the assistant
 * message in the messages array).
 */
function splitMessageAtQueueBoundaries(
  parts: UIMessageParts,
  skipFirstPrompt: boolean,
): QueueSegment[] {
  const segments: QueueSegment[] = [];
  let current: QueueSegment = { userPrompt: null, parts: [] };
  let seenFirst = false;

  for (const part of parts) {
    if (part.type === "data-prompt") {
      if (!seenFirst) {
        seenFirst = true;
        if (skipFirstPrompt) continue; // user message already in messages array
      }
      // Finish current segment and start a new one
      if (current.parts.length > 0 || segments.length > 0 || !skipFirstPrompt) {
        segments.push(current);
      }
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
  showSessionList: boolean;
  onShowSessionListChange: (show: boolean) => void;
}

export function ChatView({
  workspaceId,
  workspaceName,
  supportsSessionListing,
  initialSessionId,
  showSessionList,
  onShowSessionListChange,
}: ChatViewProps) {
  const sessionIdRef = useRef<string | undefined>(undefined);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [historicalMessages, setHistoricalMessages] = useState<HistoryMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
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
    () => new TaskChatTransport(workspaceId, () => sessionIdRef.current),
    [workspaceId],
  );

  const { messages, sendMessage, status, setMessages, stop } = useChat({
    id: workspaceId,
    transport,
    resume: true,
    onData: (dataPart) => {
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

  const abortingRef = useRef(false);

  const handleStop = useCallback(() => {
    abortingRef.current = true;
    transport.abort().finally(() => {
      abortingRef.current = false;
      stop();
    });
  }, [transport, stop]);

  const isStreaming = status === "submitted" || status === "streaming";

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

  const loadMessages = useCallback(
    async (sessionId: string) => {
      setLoadingHistory(true);
      try {
        const data = await trpc.sessions.messages.query({
          workspaceId,
          sessionId,
        });
        setHistoricalMessages(data.messages as HistoryMessage[]);
      } finally {
        setLoadingHistory(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    if (initialSessionId && !initialSessionLoadedRef.current) {
      initialSessionLoadedRef.current = true;
      sessionIdRef.current = initialSessionId;
      setActiveSessionId(initialSessionId);
      loadMessages(initialSessionId);
    }
  }, [initialSessionId, loadMessages]);

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      sessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
      setMessages([]);
      setHistoricalMessages([]);
      setQueuedMessages([]);
      trpc.queue.clear.mutate({ workspaceId }).catch(() => {});
      onShowSessionListChange(false);
      await loadMessages(sessionId);
    },
    [loadMessages, setMessages, onShowSessionListChange, workspaceId],
  );

  const handleNewSession = useCallback(() => {
    sessionIdRef.current = undefined;
    setActiveSessionId(undefined);
    setHistoricalMessages([]);
    setMessages([]);
    setQueuedMessages([]);
    trpc.queue.clear.mutate({ workspaceId }).catch(() => {});
    onShowSessionListChange(false);
  }, [setMessages, onShowSessionListChange, workspaceId]);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      if (!message.text.trim() && !message.files?.length) return;

      if (isStreaming) {
        // Agent is busy — queue the message on the backend.
        // Optimistic update for instant feedback; subscription corrects if needed.
        setQueuedMessages((prev) => [...prev, message.text]);
        trpc.queue.push.mutate({ workspaceId, text: message.text }).catch(() => {});
        return;
      }

      doSendMessage(message);
    },
    [doSendMessage, isStreaming, workspaceId],
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

  const liveTaskMap: TaskMap = useMemo(() => {
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

  // When reconnecting to a stream, the buffered chunks replay the current
  // task's content which overlaps with the tail of the session history.
  // Strip the overlapping turn from history so each message appears once.
  const filteredHistoricalMessages = useMemo(() => {
    if (historicalMessages.length === 0) return historicalMessages;
    // Find current prompt from data-prompt parts in the last assistant message
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const dataPromptPart = lastAssistant?.parts.find((p) => p.type === "data-prompt");
    const currentPrompt = dataPromptPart
      ? (dataPromptPart as { type: string; data: { text: string } }).data.text.trim()
      : undefined;
    if (!currentPrompt) return historicalMessages;
    // Strip overlapping turn from history
    for (let i = historicalMessages.length - 1; i >= 0; i--) {
      if (historicalMessages[i].role === "user") {
        const text = historicalMessages[i].content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text === currentPrompt) return historicalMessages.slice(0, i);
        break;
      }
    }
    return historicalMessages;
  }, [historicalMessages, messages]);

  const historyToolResultMap = useMemo(
    () => buildToolResultMap(filteredHistoricalMessages),
    [filteredHistoricalMessages],
  );
  const { taskMap: historyTaskMap } = useMemo(
    () => buildHistoryTaskMap(filteredHistoricalMessages, historyToolResultMap),
    [filteredHistoricalMessages, historyToolResultMap],
  );

  const displayTaskMap = liveTaskMap.size > 0 ? liveTaskMap : historyTaskMap;

  const getLastUserMessage = useCallback((): string | undefined => {
    // Check live messages: user messages first, then data-prompt parts in assistant messages
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
    // Fall back to historical messages
    for (let i = filteredHistoricalMessages.length - 1; i >= 0; i--) {
      if (filteredHistoricalMessages[i].role === "user") {
        const text = filteredHistoricalMessages[i].content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
          .trim();
        if (text) return text;
      }
    }
    return undefined;
  }, [messages, filteredHistoricalMessages]);

  const hasHistory = filteredHistoricalMessages.length > 0;
  const hasLiveMessages = messages.length > 0;
  // Detect reconnected/queued prompt: assistant message has data-prompt parts
  // but no user message exists in the live messages array.
  const hasReconnectedPrompt =
    messages.some((m) => m.role === "assistant" && m.parts.some((p) => p.type === "data-prompt")) &&
    !messages.some((m) => m.role === "user");
  const isEmpty = !hasHistory && !hasLiveMessages && !hasReconnectedPrompt;

  if (supportsSessionListing && showSessionList) {
    return (
      <SessionList
        workspaceId={workspaceId}
        activeSessionId={activeSessionId ?? sessionIdRef.current}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          {isEmpty && (
            <ConversationEmptyState
              icon={<Bot className="size-8" />}
              title={workspaceName}
              description="Send a message to start coding"
            />
          )}

          {loadingHistory && historicalMessages.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {filteredHistoricalMessages.length > 0 && (
            <HistoryMessages messages={filteredHistoricalMessages} />
          )}

          {hasHistory && (hasLiveMessages || hasReconnectedPrompt) && (
            <div className="flex items-center gap-3 py-2">
              <div className="h-px flex-1 bg-border/50" />
              <span className="text-sm text-muted-foreground">new messages</span>
              <div className="h-px flex-1 bg-border/50" />
            </div>
          )}

          {(() => {
            return messages.map((message, messageIndex) => {
              const isLastMessage = messageIndex === messages.length - 1;
              const isLastAssistant = message.role === "assistant" && isLastMessage;
              const showThinking = isLastAssistant && isStreaming;

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
              const hasPrecedingUserMsg =
                messageIndex > 0 && messages[messageIndex - 1]?.role === "user";
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
              const segments = splitMessageAtQueueBoundaries(message.parts, hasPrecedingUserMsg);

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
        <TaskListWidget tasks={displayTaskMap} />
        <PromptInput onSubmit={handleSubmit}>
          <SlashCommandSuggestions skills={skills} />
          <PromptInputTextarea
            placeholder="Type a message..."
            onEscape={handleEscape}
            onPreviousMessage={getLastUserMessage}
          />
          <PromptInputActions>
            <PromptInputAttach />
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

function QueuedMessageBubble({ text, onCancel }: { text: string; onCancel: () => void }) {
  return (
    <div className="group is-user flex w-full max-w-[95%] flex-col gap-2 ml-auto justify-end opacity-60">
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

function buildToolResultMap(messages: HistoryMessage[]) {
  const map = new Map<string, HistoryMessageContent>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.toolCallId) {
        map.set(block.toolCallId, block);
      }
    }
  }
  return map;
}

function buildHistoryTaskMap(
  messages: HistoryMessage[],
  toolResultMap: Map<string, HistoryMessageContent>,
): { taskMap: TaskMap; taskToolCallIds: Set<string> } {
  const taskToolCallIds = new Set<string>();
  let map: TaskMap = new Map();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== "tool_use" || !block.toolName || !isTaskTool(block.toolName)) continue;
      const id = block.toolCallId ?? "";
      taskToolCallIds.add(id);
      const item = historyToolToItem(block, toolResultMap.get(id));
      map = applyTaskToolCall(map, item);
    }
  }
  return { taskMap: map, taskToolCallIds };
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * Parse the "I'm sharing these files with you:" prefix that the backend
 * prepends to prompts with file attachments.  Returns the display text
 * (without the prefix) and an array of file-part objects for rendering.
 */
function parseSharedFiles(text: string): {
  displayText: string;
  files: { type: "file"; mediaType: string; url: string; filename: string }[];
} {
  const match = text.match(/^I'm sharing these files with you:\n((?:- .+\n)+)\n([\s\S]*)$/);
  if (!match) return { displayText: text, files: [] };

  const fileLines = match[1].trim().split("\n");
  const displayText = match[2].trim();

  const files = fileLines.map((line) => {
    const filePath = line.replace(/^- /, "").trim();
    const filename = filePath.split("/").pop() ?? filePath;
    const ext = filename.includes(".") ? `.${filename.split(".").pop()!.toLowerCase()}` : "";
    const isImage = IMAGE_EXTENSIONS.has(ext);
    return {
      type: "file" as const,
      mediaType: isImage
        ? `image/${ext.slice(1).replace("jpg", "jpeg")}`
        : "application/octet-stream",
      url: `/api/uploads/${encodeURIComponent(filename)}`,
      filename,
    };
  });

  return { displayText, files };
}

function HistoryMessages({ messages }: { messages: HistoryMessage[] }) {
  const toolResultMap = useMemo(() => buildToolResultMap(messages), [messages]);
  const { taskToolCallIds } = useMemo(
    () => buildHistoryTaskMap(messages, toolResultMap),
    [messages, toolResultMap],
  );

  return (
    <>
      {messages.map((msg) => (
        <HistoryMessageView
          key={msg.id}
          message={msg}
          toolResultMap={toolResultMap}
          taskToolCallIds={taskToolCallIds}
        />
      ))}
    </>
  );
}

function HistoryMessageView({
  message,
  toolResultMap,
  taskToolCallIds,
}: {
  message: HistoryMessage;
  toolResultMap: Map<string, HistoryMessageContent>;
  taskToolCallIds: Set<string>;
}) {
  const textBlocks = message.content.filter((b) => b.type === "text" && b.text?.trim());
  const toolUseBlocks = message.content.filter((b) => b.type === "tool_use");

  if (message.role === "user") {
    const userText = textBlocks.map((b) => b.text).join("\n");
    if (!userText) return null;
    const { displayText, files } = parseSharedFiles(userText);
    return (
      <Message from="user">
        <MessageContent>
          {files.map((file) => (
            <MessageFilePart key={file.url} part={file} />
          ))}
          {displayText && <MessageResponse>{displayText}</MessageResponse>}
        </MessageContent>
      </Message>
    );
  }

  if (textBlocks.length === 0 && toolUseBlocks.length === 0) return null;

  return (
    <Message from="assistant">
      <MessageContent>
        {renderHistoryContent(message, toolResultMap, taskToolCallIds)}
      </MessageContent>
    </Message>
  );
}

function historyToolToItem(
  tool: HistoryMessageContent,
  result: HistoryMessageContent | undefined,
): ToolCallItem {
  return {
    toolCallId: tool.toolCallId ?? "",
    toolName: tool.toolName ?? "unknown",
    input: tool.input,
    output: result?.output,
    errorText: result?.isError ? (result.output ?? undefined) : undefined,
    isError: result?.isError ?? false,
    isInProgress: false,
  };
}

function renderHistoryContent(
  message: HistoryMessage,
  toolResultMap: Map<string, HistoryMessageContent>,
  taskToolCallIds: Set<string>,
) {
  const elements: React.ReactNode[] = [];

  for (const block of message.content) {
    if (block.type === "text" && block.text?.trim()) {
      elements.push(
        <MessageResponse key={`text-${elements.length}`}>{block.text}</MessageResponse>,
      );
    } else if (block.type === "tool_use") {
      const callId = block.toolCallId ?? "";
      if (taskToolCallIds.has(callId)) {
        continue;
      }
      const item = historyToolToItem(block, toolResultMap.get(callId));
      elements.push(<ToolCall key={`tool-${elements.length}`} item={item} />);
    }
  }

  return elements;
}
