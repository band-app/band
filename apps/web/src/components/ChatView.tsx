import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";
import { Bot, Loader2 } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "./ai-elements/conversation";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "./ai-elements/message";
import type { PromptInputMessage } from "./ai-elements/prompt-input";
import {
	PromptInput,
	PromptInputSubmit,
	PromptInputTextarea,
} from "./ai-elements/prompt-input";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "./ai-elements/tool";

function ThinkingIndicator() {
	return (
		<div className="flex items-center gap-2 text-muted-foreground">
			<Loader2 className="size-4 animate-spin" />
			<span className="text-sm">Thinking...</span>
		</div>
	);
}

interface ChatViewProps {
	workspaceId: string;
	workspaceName: string;
}

export function ChatView({ workspaceId, workspaceName }: ChatViewProps) {
	const sessionIdRef = useRef<string | undefined>(undefined);

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

	const { messages, sendMessage, status } = useChat({
		transport,
		onData: (dataPart) => {
			if (
				dataPart.type === "data-session" &&
				dataPart.data != null &&
				typeof dataPart.data === "object" &&
				"sessionId" in (dataPart.data as Record<string, unknown>)
			) {
				sessionIdRef.current = (
					dataPart.data as { sessionId: string }
				).sessionId;
			}
		},
	});

	const isStreaming = status === "submitted" || status === "streaming";

	const handleSubmit = useCallback(
		(message: PromptInputMessage) => {
			if (!message.text.trim()) return;
			sendMessage({ text: message.text });
		},
		[sendMessage],
	);

	return (
		<div className="flex h-full flex-col">
			<Conversation className="min-h-0 flex-1">
				<ConversationContent>
					{messages.length === 0 && (
						<ConversationEmptyState
							icon={<Bot className="size-8" />}
							title={workspaceName}
							description="Send a message to start coding"
						/>
					)}
					{messages.map((message, messageIndex) => {
						const isLastMessage = messageIndex === messages.length - 1;
						const isLastAssistant =
							message.role === "assistant" && isLastMessage;
						const showThinking = isLastAssistant && isStreaming;

						const visibleParts = message.parts.filter(
							(p) =>
								(p.type === "text" && p.text.trim()) ||
								isToolUIPart(p),
						);
						if (
							message.role === "assistant" &&
							visibleParts.length === 0 &&
							!showThinking
						) {
							return null;
						}
						return (
							<Message key={message.id} from={message.role}>
								<MessageContent>
									{message.parts.map((part, partIndex) => {
										if (part.type === "text" && part.text.trim()) {
											return (
												<MessageResponse
													key={`${message.id}-text-${partIndex}`}
												>
													{part.text}
												</MessageResponse>
											);
										}
										if (isToolUIPart(part)) {
											const toolName = getToolName(part);
											const headerProps =
												part.type === "dynamic-tool"
													? {
															type: part.type,
															state: part.state,
															toolName,
															title: toolName,
														}
													: {
															type: part.type,
															state: part.state,
															title: toolName,
														};
											return (
												<Tool key={part.toolCallId}>
													<ToolHeader {...headerProps} />
													<ToolContent>
														<ToolInput input={part.input} />
														<ToolOutput
															output={part.output}
															errorText={part.errorText}
														/>
													</ToolContent>
												</Tool>
											);
										}
										return null;
									})}
									{showThinking && <ThinkingIndicator />}
								</MessageContent>
							</Message>
						);
					})}
					{isStreaming &&
						(!messages.length ||
							messages[messages.length - 1].role === "user") && (
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
