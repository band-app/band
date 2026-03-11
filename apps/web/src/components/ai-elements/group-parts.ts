import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";

import type { ToolPart } from "./tool";

type Part = UIMessage["parts"][number];

export type TextSegment = {
  type: "text";
  part: Part;
  partIndex: number;
};

export type ToolSegment = {
  type: "tool";
  part: ToolPart;
  partIndex: number;
};

export type FileSegment = {
  type: "file";
  part: { type: "file"; mediaType: string; url: string; filename?: string };
  partIndex: number;
};

export type MessageSegment = TextSegment | ToolSegment | FileSegment;

/**
 * Separates message parts into text, tool, and file segments.
 * Empty/whitespace-only text parts are skipped.
 */
export function groupMessageParts(parts: Part[]): MessageSegment[] {
  const segments: MessageSegment[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (isToolUIPart(part)) {
      segments.push({ type: "tool", part: part as ToolPart, partIndex: i });
      continue;
    }

    if (part.type === "file") {
      segments.push({
        type: "file",
        part: part as FileSegment["part"],
        partIndex: i,
      });
      continue;
    }

    if (part.type === "text" && part.text.trim()) {
      segments.push({ type: "text", part, partIndex: i });
    }
  }

  return segments;
}
