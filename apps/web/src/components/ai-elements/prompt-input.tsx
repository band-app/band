import type { ChatStatus } from "ai";
import type {
	ComponentProps,
	FormEvent,
	FormEventHandler,
	HTMLAttributes,
	KeyboardEventHandler,
} from "react";

import { cn } from "@band/ui";
import { CornerDownLeftIcon, Loader2, SquareIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

export interface PromptInputMessage {
	text: string;
}

export type PromptInputProps = Omit<
	HTMLAttributes<HTMLFormElement>,
	"onSubmit"
> & {
	onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void;
};

export const PromptInput = ({
	className,
	onSubmit,
	children,
	...props
}: PromptInputProps) => {
	const formRef = useRef<HTMLFormElement | null>(null);

	const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
		(event) => {
			event.preventDefault();
			const formData = new FormData(event.currentTarget);
			const text = (formData.get("message") as string) || "";
			if (!text.trim()) return;
			event.currentTarget.reset();
			onSubmit({ text }, event);
		},
		[onSubmit],
	);

	return (
		<form
			className={cn("flex w-full items-end gap-2 rounded-md border border-border/50 bg-card p-2", className)}
			onSubmit={handleSubmit}
			ref={formRef}
			{...props}
		>
			{children}
		</form>
	);
};

export type PromptInputTextareaProps = HTMLAttributes<HTMLTextAreaElement> & {
	placeholder?: string;
};

export const PromptInputTextarea = ({
	className,
	placeholder = "Type a message...",
	...props
}: PromptInputTextareaProps) => {
	const [isComposing, setIsComposing] = useState(false);

	const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
		(e) => {
			if (e.key === "Enter") {
				if (isComposing || e.nativeEvent.isComposing) return;
				if (e.shiftKey) return;
				e.preventDefault();
				e.currentTarget.form?.requestSubmit();
			}
		},
		[isComposing],
	);

	return (
		<textarea
			autoComplete="off"
			autoCorrect="off"
			spellCheck={false}
			className={cn(
				"min-h-[44px] max-h-48 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm outline-none placeholder:text-muted-foreground field-sizing-content",
				className,
			)}
			name="message"
			onCompositionEnd={() => setIsComposing(false)}
			onCompositionStart={() => setIsComposing(true)}
			onKeyDown={handleKeyDown}
			placeholder={placeholder}
			{...props}
		/>
	);
};

export type PromptInputSubmitProps = ComponentProps<"button"> & {
	status?: ChatStatus;
};

export const PromptInputSubmit = ({
	className,
	status,
	...props
}: PromptInputSubmitProps) => {
	const isGenerating = status === "submitted" || status === "streaming";

	let Icon = <CornerDownLeftIcon className="size-4" />;
	if (status === "submitted") {
		Icon = <Loader2 className="size-4 animate-spin" />;
	} else if (status === "streaming") {
		Icon = <SquareIcon className="size-4" />;
	}

	return (
		<button
			type="submit"
			className={cn(
				"inline-flex size-7 shrink-0 items-center justify-center rounded bg-muted-foreground/80 text-background transition-colors hover:bg-muted-foreground disabled:opacity-50",
				className,
			)}
			disabled={isGenerating}
			{...props}
		>
			{Icon}
		</button>
	);
};
