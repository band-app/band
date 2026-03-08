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

  const loadMessages = useCallback(
    async (sessionId: string) => {
      setLoadingHistory(true);
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sessionId)}/messages`,
        );
        if (!res.ok) throw new Error("Failed to load messages");
        const data = (await res.json()) as { messages: HistoryMessage[] };
        setHistoricalMessages(data.messages);
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
      onShowSessionListChange(false);
      await loadMessages(sessionId);
    },
    [loadMessages, setMessages, onShowSessionListChange],
  );

  const handleNewSession = useCallback(() => {
    sessionIdRef.current = undefined;
    setActiveSessionId(undefined);
    setHistoricalMessages([]);
    setMessages([]);
    onShowSessionListChange(false);
  }, [setMessages, onShowSessionListChange]);

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

          {loadingHistory && historicalMessages.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {historicalMessages.length > 0 && <HistoryMessages messages={historicalMessages} />}

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

function HistoryMessages({ messages }: { messages: HistoryMessage[] }) {
  const toolResultMap = useMemo(() => buildToolResultMap(messages), [messages]);

  return (
    <>
      {messages.map((msg) => (
        <HistoryMessageView key={msg.id} message={msg} toolResultMap={toolResultMap} />
      ))}
    </>
  );
}

function HistoryMessageView({
  message,
  toolResultMap,
}: {
  message: HistoryMessage;
  toolResultMap: Map<string, HistoryMessageContent>;
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
      <MessageContent>{renderHistoryContent(message, toolResultMap)}</MessageContent>
    </Message>
  );
}

function renderHistoryContent(
  message: HistoryMessage,
  toolResultMap: Map<string, HistoryMessageContent>,
) {
  const elements: React.ReactNode[] = [];
  let toolGroup: HistoryMessageContent[] = [];

  const flushToolGroup = () => {
    if (toolGroup.length > 0) {
      elements.push(
        <HistoryToolGroup
          key={`tools-${elements.length}`}
          tools={toolGroup}
          toolResultMap={toolResultMap}
        />,
      );
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

function HistoryToolGroup({
  tools,
  toolResultMap,
}: {
  tools: HistoryMessageContent[];
  toolResultMap: Map<string, HistoryMessageContent>;
}) {
  const errorCount = tools.filter((t) => toolResultMap.get(t.toolCallId ?? "")?.isError).length;

  return (
    <Collapsible className="group/outer not-prose mb-4 w-full rounded border border-border/50">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3">
        <div className="flex items-center gap-2">
          <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium text-sm text-muted-foreground">
            {tools.length} tool{tools.length !== 1 ? " calls" : " call"} completed
            {errorCount > 0 && ` (${errorCount} failed)`}
          </span>
        </div>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/outer:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/50">
          {tools.map((tool) => {
            const result = toolResultMap.get(tool.toolCallId ?? "");
            return <HistoryToolItem key={tool.toolCallId} tool={tool} result={result} />;
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function formatToolTitle(tool: HistoryMessageContent): string {
  const name = tool.toolName ?? "unknown";
  const input = tool.input as Record<string, unknown> | null | undefined;
  if (!input) return name;

  const arg =
    input.command ?? input.pattern ?? input.query ?? input.file_path ?? input.url ?? input.content;

  if (typeof arg === "string") {
    const summary = arg.length > 80 ? `${arg.slice(0, 80)}...` : arg;
    return `${name}(${summary})`;
  }

  return name;
}

function HistoryToolItem({
  tool,
  result,
}: {
  tool: HistoryMessageContent;
  result?: HistoryMessageContent;
}) {
  return (
    <Collapsible className="group/inner border-b border-border/50 last:border-b-0">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 px-4 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`size-2 shrink-0 rounded-full ${result?.isError ? "bg-red-500" : "bg-green-500"}`}
          />
          <span className="text-sm truncate">{formatToolTitle(tool)}</span>
        </div>
        <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]/inner:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-4 pb-3">
        {tool.input != null && (
          <div className="space-y-2 overflow-hidden">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Parameters
            </h4>
            <div className="rounded-md bg-muted/50">
              <pre className="overflow-auto p-3 text-xs">
                <code>{JSON.stringify(tool.input, null, 2)}</code>
              </pre>
            </div>
          </div>
        )}
        {result?.output && (
          <div className="space-y-2">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {result.isError ? "Error" : "Result"}
            </h4>
            <div
              className={`overflow-x-auto rounded-md text-xs ${result.isError ? "bg-destructive/10 text-destructive" : "bg-muted/50"}`}
            >
              <pre className="overflow-auto p-3 text-xs">
                <code>{result.output}</code>
              </pre>
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
