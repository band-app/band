import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";

import type { ToolPart } from "./tool";

type Part = UIMessage["parts"][number];

export type TextSegment = {
	type: "text";
	part: Part;
	partIndex: number;
};

export type ToolGroupSegment = {
	type: "tool-group";
	parts: Array<{ part: ToolPart; partIndex: number }>;
	/** Index of the first tool part in the group, used as a stable React key */
	startIndex: number;
};

export type MessageSegment = TextSegment | ToolGroupSegment;

/**
 * Groups consecutive tool UI parts into ToolGroupSegments.
 * Empty/whitespace-only text parts are skipped and do not break tool grouping.
 * All other non-tool parts become individual TextSegments.
 */
export function groupMessageParts(parts: Part[]): MessageSegment[] {
	const segments: MessageSegment[] = [];
	let currentToolGroup: ToolGroupSegment | null = null;

	const flushToolGroup = () => {
		if (currentToolGroup) {
			segments.push(currentToolGroup);
			currentToolGroup = null;
		}
	};

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];

		if (isToolUIPart(part)) {
			if (!currentToolGroup) {
				currentToolGroup = { type: "tool-group", parts: [], startIndex: i };
			}
			currentToolGroup.parts.push({ part: part as ToolPart, partIndex: i });
			continue;
		}

		// Only non-empty text parts break tool grouping and become segments.
		// Everything else (empty text, step-start, reasoning, source-url, etc.)
		// is skipped so consecutive tool calls stay grouped.
		if (part.type === "text" && part.text.trim()) {
			flushToolGroup();
			segments.push({ type: "text", part, partIndex: i });
		}
	}

	flushToolGroup();
	return segments;
}
