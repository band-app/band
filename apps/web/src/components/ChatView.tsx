import { useChat } from "@ai-sdk/react";
import { Badge } from "@band/ui";
import { getToolName, isToolUIPart } from "ai";
import { Bot, Clock, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

interface QueuedMessage {
  id: string;
  message: PromptInputMessage;
  queuedAt: number;
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
  const [reconnectedPrompt, setReconnectedPrompt] = useState<string | undefined>(undefined);
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
      // Store reconnected prompt for rendering (don't inject into useChat state)
      if (
        dataPart.type === "data-prompt" &&
        dataPart.data != null &&
        typeof dataPart.data === "object" &&
        "text" in (dataPart.data as Record<string, unknown>)
      ) {
        setReconnectedPrompt((dataPart.data as { text: string }).text);
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

  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const sendingQueuedRef = useRef(false);

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
        const data = await trpc.sessions.messages.query({ workspaceId, sessionId });
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
      setReconnectedPrompt(undefined);
      setActiveSessionId(sessionId);
      setMessages([]);
      setHistoricalMessages([]);
      setQueuedMessages([]);
      onShowSessionListChange(false);
      await loadMessages(sessionId);
    },
    [loadMessages, setMessages, onShowSessionListChange],
  );

  const handleNewSession = useCallback(() => {
    sessionIdRef.current = undefined;
    setReconnectedPrompt(undefined);
    setActiveSessionId(undefined);
    setHistoricalMessages([]);
    setMessages([]);
    setQueuedMessages([]);
    onShowSessionListChange(false);
  }, [setMessages, onShowSessionListChange]);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      if (!message.text.trim() && !message.files?.length) return;

      if (isStreaming) {
        // Agent is busy — queue the message instead of sending
        setQueuedMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            message,
            queuedAt: Date.now(),
          },
        ]);
        return;
      }

      doSendMessage(message);
    },
    [doSendMessage, isStreaming],
  );

  // Auto-send queued messages when the agent becomes idle
  useEffect(() => {
    if (isStreaming) {
      sendingQueuedRef.current = false;
      return;
    }
    if (sendingQueuedRef.current) return;
    if (queuedMessages.length === 0) return;

    sendingQueuedRef.current = true;
    const [next, ...rest] = queuedMessages;
    setQueuedMessages(rest);
    doSendMessage(next.message);
  }, [isStreaming, queuedMessages, doSendMessage]);

  const handleCancelQueued = useCallback((id: string) => {
    setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

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
    if (!reconnectedPrompt || historicalMessages.length === 0) {
      return historicalMessages;
    }
    const promptText = reconnectedPrompt.trim();
    for (let i = historicalMessages.length - 1; i >= 0; i--) {
      if (historicalMessages[i].role === "user") {
        const text = historicalMessages[i].content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text === promptText) {
          return historicalMessages.slice(0, i);
        }
        break;
      }
    }
    return historicalMessages;
  }, [historicalMessages, reconnectedPrompt]);

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
    // Check live messages first (most recent)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        const text = messages[i].parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .trim();
        if (text) return text;
      }
    }
    // Fall back to reconnected prompt
    if (reconnectedPrompt) return reconnectedPrompt;
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
  }, [messages, reconnectedPrompt, filteredHistoricalMessages]);

  const hasHistory = filteredHistoricalMessages.length > 0;
  const hasLiveMessages = messages.length > 0;
  // Show the reconnected prompt as a user message when the stream is
  // providing the current task (no user message in live stream).
  const showReconnectedPrompt = reconnectedPrompt && !messages.some((m) => m.role === "user");
  const isEmpty = !hasHistory && !hasLiveMessages && !showReconnectedPrompt;

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

          {hasHistory && (hasLiveMessages || showReconnectedPrompt) && (
            <div className="flex items-center gap-3 py-2">
              <div className="h-px flex-1 bg-border/50" />
              <span className="text-sm text-muted-foreground">new messages</span>
              <div className="h-px flex-1 bg-border/50" />
            </div>
          )}

          {showReconnectedPrompt && (
            <Message from="user">
              <MessageContent>
                <MessageResponse>{reconnectedPrompt}</MessageResponse>
              </MessageContent>
            </Message>
          )}

          {(() => {
            return messages.map((message, messageIndex) => {
              const isLastMessage = messageIndex === messages.length - 1;
              const isLastAssistant = message.role === "assistant" && isLastMessage;
              const showThinking = isLastAssistant && isStreaming;

              const visibleParts = message.parts.filter(
                (p) => (p.type === "text" && p.text.trim()) || p.type === "file" || isToolUIPart(p),
              );
              if (message.role === "assistant" && visibleParts.length === 0 && !showThinking) {
                return null;
              }
              return (
                <Message key={message.id} from={message.role}>
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
                      if (isTaskTool(item.toolName)) {
                        return null;
                      }
                      return (
                        <ToolCall key={`${message.id}-tool-${segment.partIndex}`} item={item} />
                      );
                    })}
                    {showThinking && <ThinkingIndicator />}
                  </MessageContent>
                </Message>
              );
            });
          })()}
          {isStreaming && (!messages.length || messages[messages.length - 1].role === "user") && (
            <Message from="assistant">
              <MessageContent>
                <ThinkingIndicator />
              </MessageContent>
            </Message>
          )}

          {queuedMessages.map((qm) => (
            <QueuedMessageBubble
              key={qm.id}
              queuedMessage={qm}
              onCancel={() => handleCancelQueued(qm.id)}
            />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl shrink-0 px-3 lg:px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
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

function QueuedMessageBubble({
  queuedMessage,
  onCancel,
}: {
  queuedMessage: QueuedMessage;
  onCancel: () => void;
}) {
  return (
    <div className="group is-user flex w-full max-w-[95%] flex-col gap-2 ml-auto justify-end opacity-60">
      <div className="flex min-w-0 max-w-full flex-col gap-2 break-words text-base ml-auto w-fit rounded-md bg-secondary px-4 py-3 text-foreground">
        <MessageResponse>{queuedMessage.message.text}</MessageResponse>
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
        {renderHistoryContent(
          message,
          toolResultMap,
          taskToolCallIds,
        )}
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
