import { type AgentIconData, agentIconFor } from "@band-app/shared/agent-icons";
import { cn } from "@band-app/ui";

interface IconProps {
  className?: string;
}

function MarkIcon({ data, className }: { data: AgentIconData; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={data.viewBox}
      fill="currentColor"
      // The brand tint flows through `currentColor`, so a parent `text-muted-foreground` and
      // `forced-colors: active` both affect the icon. cn() uses tailwind-merge, so a
      // caller-supplied `text-*` wins.
      // theme-lint-ignore-line: Anthropic brand color
      className={data.brandColor ? cn("text-[#D97757]", className) : className}
      role="img"
      aria-label={data.label}
    >
      {data.paths.map((p) => (
        <path key={p.d} d={p.d} fillOpacity={p.fillOpacity} fillRule={p.fillRule} />
      ))}
    </svg>
  );
}

function iconFor(type: string) {
  return function Icon({ className }: IconProps) {
    const data = agentIconFor(type);
    return data ? <MarkIcon data={data} className={className} /> : null;
  };
}

export const ClaudeIcon = iconFor("claude-code");
export const CodexIcon = iconFor("codex");
export const OpenCodeIcon = iconFor("opencode");
export const GeminiIcon = iconFor("gemini-cli");
export const CursorIcon = iconFor("cursor-cli");

export function AgentIcon({ type, className }: { type: string; className?: string }) {
  const data = agentIconFor(type);
  return data ? <MarkIcon data={data} className={className} /> : null;
}
