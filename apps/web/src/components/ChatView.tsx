import { useChat } from "@ai-sdk/react";
import { getToolName, isToolUIPart } from "ai";
import { Bot, Loader2 } from "lucide-react";
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
      <Loader2 className="size-4 animate-spin" />
      <span className="text-base">Thinking...</span>
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
  const reconnectedPromptRef = useRef<string | undefined>(undefined);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [historicalMessages, setHistoricalMessages] = useState<HistoryMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const initialSessionLoadedRef = useRef(false);

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
        reconnectedPromptRef.current = (dataPart.data as { text: string }).text;
      }
    },
  });

  const handleStop = useCallback(() => {
    transport.abort();
    stop();
  }, [transport, stop]);

  const isStreaming = status === "submitted" || status === "streaming";

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
      reconnectedPromptRef.current = undefined;
      setActiveSessionId(sessionId);
      setMessages([]);
      setHistoricalMessages([]);
      onShowSessionListChange(false);
      await loadMessages(sessionId);
    },
    [loadMessages, setMessages, onShowSessionListChange],
  );

  const handleNewSession = useCallback(() => {
    sessionIdRef.current = undefined;
    reconnectedPromptRef.current = undefined;
    setActiveSessionId(undefined);
    setHistoricalMessages([]);
    setMessages([]);
    onShowSessionListChange(false);
  }, [setMessages, onShowSessionListChange]);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      if (!message.text.trim() && !message.files?.length) return;
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

  const hasHistory = historicalMessages.length > 0;
  const hasLiveMessages = messages.length > 0;
  // Show reconnected prompt only when history doesn't already include it
  const showReconnectedPrompt =
    reconnectedPromptRef.current && !hasHistory && !messages.some((m) => m.role === "user");
  const isEmpty = !hasHistory && !hasLiveMessages && !showReconnectedPrompt;

  return (
    <div className="flex h-full flex-col">
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

          {historicalMessages.length > 0 && <HistoryMessages messages={historicalMessages} />}

          {hasHistory && hasLiveMessages && (
            <div className="flex items-center gap-3 py-2">
              <div className="h-px flex-1 bg-border/50" />
              <span className="text-sm text-muted-foreground">new messages</span>
              <div className="h-px flex-1 bg-border/50" />
            </div>
          )}

          {showReconnectedPrompt && (
            <Message from="user">
              <MessageContent>
                <MessageResponse>{reconnectedPromptRef.current}</MessageResponse>
              </MessageContent>
            </Message>
          )}

          {(() => {
            let taskWidgetRendered = false;
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
                    {message.role === "user" &&
                      message.parts.map((part, partIdx) =>
                        part.type === "file" ? (
                          <MessageFilePart
                            key={`${message.id}-file-${part.filename ?? partIdx}`}
                            part={
                              part as {
                                type: "file";
                                mediaType: string;
                                url: string;
                                filename?: string;
                              }
                            }
                          />
                        ) : null,
                      )}
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
                        if (!taskWidgetRendered && liveTaskMap.size > 0) {
                          taskWidgetRendered = true;
                          return <TaskListWidget key="task-list-widget" tasks={liveTaskMap} />;
                        }
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
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea placeholder="Type a message..." />
          <PromptInputActions>
            <PromptInputAttach />
            <PromptInputSubmit status={status} onStop={handleStop} />
          </PromptInputActions>
        </PromptInput>
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

function HistoryMessages({ messages }: { messages: HistoryMessage[] }) {
  const toolResultMap = useMemo(() => buildToolResultMap(messages), [messages]);
  const { taskMap, taskToolCallIds } = useMemo(
    () => buildHistoryTaskMap(messages, toolResultMap),
    [messages, toolResultMap],
  );

  let taskWidgetRendered = false;

  return (
    <>
      {messages.map((msg) => (
        <HistoryMessageView
          key={msg.id}
          message={msg}
          toolResultMap={toolResultMap}
          taskMap={taskMap}
          taskToolCallIds={taskToolCallIds}
          taskWidgetRendered={taskWidgetRendered}
          onTaskWidgetRendered={() => {
            taskWidgetRendered = true;
          }}
        />
      ))}
    </>
  );
}

function HistoryMessageView({
  message,
  toolResultMap,
  taskMap,
  taskToolCallIds,
  taskWidgetRendered,
  onTaskWidgetRendered,
}: {
  message: HistoryMessage;
  toolResultMap: Map<string, HistoryMessageContent>;
  taskMap: TaskMap;
  taskToolCallIds: Set<string>;
  taskWidgetRendered: boolean;
  onTaskWidgetRendered: () => void;
}) {
  const textBlocks = message.content.filter((b) => b.type === "text" && b.text?.trim());
  const toolUseBlocks = message.content.filter((b) => b.type === "tool_use");

  if (message.role === "user") {
    const userText = textBlocks.map((b) => b.text).join("\n");
    if (!userText) return null;
    return (
      <Message from="user">
        <MessageContent>
          <MessageResponse>{userText}</MessageResponse>
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
          taskMap,
          taskToolCallIds,
          taskWidgetRendered,
          onTaskWidgetRendered,
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
  taskMap: TaskMap,
  taskToolCallIds: Set<string>,
  taskWidgetRendered: boolean,
  onTaskWidgetRendered: () => void,
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
        if (!taskWidgetRendered && taskMap.size > 0) {
          taskWidgetRendered = true;
          onTaskWidgetRendered();
          elements.push(<TaskListWidget key="task-list-widget" tasks={taskMap} />);
        }
        continue;
      }
      const item = historyToolToItem(block, toolResultMap.get(callId));
      elements.push(<ToolCall key={`tool-${elements.length}`} item={item} />);
    }
  }

  return elements;
}
