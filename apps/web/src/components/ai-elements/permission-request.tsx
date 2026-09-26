import { Button } from "@band-app/ui";
import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import type { Entry } from "../chat/transcript";
import { MessageResponse } from "./message";

type PermissionEntry = Extract<Entry, { kind: "permission" }>;

/**
 * An ACP `session/request_permission`: the agent's own rules said to ask
 * before running a tool call. Shows the call, any content the agent
 * attached (Claude Code's plan approval carries the plan markdown), and
 * one button per option the agent offered.
 */
export function PermissionRequest({
  entry,
  onAnswer,
}: {
  entry: PermissionEntry;
  onAnswer: (optionId: string | null) => Promise<void>;
}) {
  const { toolCall, options } = entry.request;
  const [sending, setSending] = useState<string | null>(null);
  const answer = useCallback(
    async (optionId: string | null) => {
      setSending(optionId ?? "cancel");
      try {
        await onAnswer(optionId);
      } finally {
        setSending(null);
      }
    },
    [onAnswer],
  );

  const texts = (toolCall.content ?? []).flatMap((c) =>
    c.type === "content" && c.content.type === "text" ? [c.content.text] : [],
  );
  const picked = entry.answer ? options.find((o) => o.optionId === entry.answer) : undefined;

  return (
    <div
      data-testid="chat-pane__permission"
      data-answered={entry.answer ? "true" : "false"}
      className="not-prose space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="text-sm">
        <span className="text-muted-foreground">The agent asks to run </span>
        <span className="font-medium">{toolCall.title ?? "a tool"}</span>
      </div>
      {texts.map((text, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: content blocks have no id
        <MessageResponse key={i}>{text}</MessageResponse>
      ))}
      {entry.answer ? (
        <div className="text-sm text-muted-foreground">
          {picked ? picked.name : entry.answer === "cancelled" ? "Not answered" : entry.answer}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {options.map((option) => (
            <Button
              key={option.optionId}
              size="sm"
              variant={option.kind.startsWith("allow") ? "default" : "outline"}
              disabled={sending !== null}
              onClick={() => void answer(option.optionId)}
            >
              {sending === option.optionId && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              {option.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
