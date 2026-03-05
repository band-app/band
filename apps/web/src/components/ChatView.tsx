import { useChat } from "@ai-sdk/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@band/ui";
import { DefaultChatTransport, isToolUIPart } from "ai";
import { Bot, ChevronDownIcon, Loader2, WrenchIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import { groupMessageParts } from "./ai-elements/group-parts";
import { Message, MessageContent, MessageResponse } from "./ai-elements/message";
import type { PromptInputMessage } from "./ai-elements/prompt-input";
import { PromptInput, PromptInputSubmit, PromptInputTextarea } from "./ai-elements/prompt-input";
import { ToolCallGroup } from "./ai-elements/tool-call-group";
import { SessionList } from "./SessionList";

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      <span className="text-sm">Thinking...</span>
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
  showSessionList: boolean;
  onShowSessionListChange: (show: boolean) => void;
}

export function ChatView({
  workspaceId,
  workspaceName,
  supportsSessionListing,
  showSessionList,
  onShowSessionListChange,
}: ChatViewProps) {
  const sessionIdRef = useRef<string | undefined>(undefined);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [historicalMessages, setHistoricalMessages] = useState<HistoryMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        body: () => ({
          sessionId: sessionIdRef.current,
          workspaceId,
        }),
      }),
    [workspaceId],
  );

  const { messages, sendMessage, status, setMessages } = useChat({
    transport,
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

  const isStreaming = status === "submitted" || status === "streaming";

  const PAGE_SIZE = 50;

  const loadMessages = useCallback(
    async (sessionId: string, offset: number) => {
      setLoadingHistory(true);
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sessionId)}/messages?limit=${PAGE_SIZE}&offset=${offset}`,
        );
        if (!res.ok) throw new Error("Failed to load messages");
        const data = (await res.json()) as { messages: HistoryMessage[] };
        if (offset === 0) {
          setHistoricalMessages(data.messages);
        } else {
          setHistoricalMessages((prev) => [...data.messages, ...prev]);
        }
        setHistoryOffset(offset + data.messages.length);
        setHasMoreHistory(data.messages.length === PAGE_SIZE);
      } finally {
        setLoadingHistory(false);
      }
    },
    [workspaceId],
  );

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      sessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
      setMessages([]);
      setHistoricalMessages([]);
      setHistoryOffset(0);
      setHasMoreHistory(false);
      onShowSessionListChange(false);
      await loadMessages(sessionId, 0);
    },
    [loadMessages, setMessages, onShowSessionListChange],
  );

  const handleNewSession = useCallback(() => {
    sessionIdRef.current = undefined;
    setActiveSessionId(undefined);
    setHistoricalMessages([]);
    setHistoryOffset(0);
    setHasMoreHistory(false);
    setMessages([]);
    onShowSessionListChange(false);
  }, [setMessages, onShowSessionListChange]);

  const handleLoadMore = useCallback(() => {
    if (activeSessionId && !loadingHistory) {
      loadMessages(activeSessionId, historyOffset);
    }
  }, [activeSessionId, loadingHistory, historyOffset, loadMessages]);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      if (!message.text.trim()) return;
      sendMessage({ text: message.text });
    },
    [sendMessage],
  );

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
  const isEmpty = !hasHistory && !hasLiveMessages;

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

          {hasMoreHistory && (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingHistory}
                className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/80 disabled:opacity-50"
              >
                {loadingHistory ? <Loader2 className="size-3 animate-spin" /> : null}
                Load earlier messages
              </button>
            </div>
          )}

          {loadingHistory && historicalMessages.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {historicalMessages.map((msg) => (
            <HistoryMessageView key={msg.id} message={msg} />
          ))}

          {hasHistory && hasLiveMessages && (
            <div className="flex items-center gap-3 py-2">
              <div className="h-px flex-1 bg-border/50" />
              <span className="text-xs text-muted-foreground">new messages</span>
              <div className="h-px flex-1 bg-border/50" />
            </div>
          )}

          {messages.map((message, messageIndex) => {
            const isLastMessage = messageIndex === messages.length - 1;
            const isLastAssistant = message.role === "assistant" && isLastMessage;
            const showThinking = isLastAssistant && isStreaming;

            const visibleParts = message.parts.filter(
              (p) => (p.type === "text" && p.text.trim()) || isToolUIPart(p),
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
                    return (
                      <ToolCallGroup
                        key={`${message.id}-tools-${segment.startIndex}`}
                        segment={segment}
                      />
                    );
                  })}
                  {showThinking && <ThinkingIndicator />}
                </MessageContent>
              </Message>
            );
          })}
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

      <div className="shrink-0 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea placeholder="Type a message..." />
          <PromptInputSubmit status={status} />
        </PromptInput>
      </div>
    </div>
  );
}

function HistoryMessageView({ message }: { message: HistoryMessage }) {
  const textBlocks = message.content.filter((b) => b.type === "text" && b.text?.trim());
  const toolUseBlocks = message.content.filter((b) => b.type === "tool_use");
  const toolResultBlocks = message.content.filter((b) => b.type === "tool_result");

  if (message.role === "user") {
    const userText = textBlocks.map((b) => b.text).join("\n");
    if (!userText && toolResultBlocks.length === 0) return null;
    if (toolResultBlocks.length > 0 && !userText) return null;
    return (
      <Message from="user">
        <MessageContent>{userText && <MessageResponse>{userText}</MessageResponse>}</MessageContent>
      </Message>
    );
  }

  if (textBlocks.length === 0 && toolUseBlocks.length === 0) return null;

  return (
    <Message from="assistant">
      <MessageContent>{renderHistoryContent(message)}</MessageContent>
    </Message>
  );
}

function renderHistoryContent(message: HistoryMessage) {
  const elements: React.ReactNode[] = [];
  let toolGroup: HistoryMessageContent[] = [];

  const flushToolGroup = () => {
    if (toolGroup.length > 0) {
      elements.push(<HistoryToolGroup key={`tools-${elements.length}`} tools={toolGroup} />);
      toolGroup = [];
    }
  };

  for (const block of message.content) {
    if (block.type === "text" && block.text?.trim()) {
      flushToolGroup();
      elements.push(
        <MessageResponse key={`text-${elements.length}`}>{block.text}</MessageResponse>,
      );
    } else if (block.type === "tool_use") {
      toolGroup.push(block);
    }
  }
  flushToolGroup();

  return elements;
}

function HistoryToolGroup({ tools }: { tools: HistoryMessageContent[] }) {
  return (
    <Collapsible className="group/outer not-prose mb-4 w-full rounded border border-border/50">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3">
        <div className="flex items-center gap-2">
          <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium text-sm text-muted-foreground">
            {tools.length} tool{tools.length !== 1 ? " calls" : " call"} completed
          </span>
        </div>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/outer:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/50">
          {tools.map((tool) => (
            <div
              key={tool.toolCallId}
              className="border-b border-border/50 px-4 py-2 last:border-b-0"
            >
              <div className="flex items-center gap-2">
                <span className="size-2 shrink-0 rounded-full bg-green-500" />
                <span className="text-sm">{tool.toolName}</span>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
