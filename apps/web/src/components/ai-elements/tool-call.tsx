import { Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from "@band-app/ui";
import { ChevronRightIcon } from "lucide-react";
import { memo, type ReactNode, useMemo } from "react";
import {
  describeTool,
  formatToolDuration,
  OUTPUT_LIMIT,
  shellRun,
  summarizeTools,
  type ToolLabel,
  toolDuration,
  toolState,
} from "../chat/tool-summary";
import type { ToolEntry } from "../chat/transcript";
import { diffLines } from "./diff-lines";
import { MessageResponse } from "./message";
import { ToolInput, ToolOutput } from "./tool";

/** Relative to the workspace when the path is inside it. */
function shortPath(path: string, cwd: string | undefined): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function Diff({
  path,
  oldText,
  newText,
  cwd,
}: {
  path: string;
  oldText?: string | null;
  newText: string;
  cwd?: string;
}) {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  return (
    <div
      data-testid="tool-call__diff"
      className="overflow-hidden rounded-md border border-border/30"
    >
      <div className="border-b border-border/30 bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">
        {shortPath(path, cwd)}
        {!oldText && <span className="ml-2 text-green-600 dark:text-green-400">new file</span>}
      </div>
      <pre className="max-h-80 overflow-auto text-xs leading-5">
        {lines.map((line, i) =>
          line.kind === "gap" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond position
            <div key={i} className="px-2 text-muted-foreground/60">
              ⋯ {line.skipped} unchanged {line.skipped === 1 ? "line" : "lines"}
            </div>
          ) : (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond position
              key={i}
              className={cn(
                "whitespace-pre px-2",
                line.kind === "add" && "bg-green-500/15",
                line.kind === "del" && "bg-red-500/15",
              )}
            >
              <span className="select-none text-muted-foreground/60">
                {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
              </span>
              {line.text}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}

/** Rotates when its own collapsible is open; `openClass` names that
 *  collapsible's Tailwind group, so a group's rows don't turn with it. */
function Chevron({ openClass }: { openClass: string }) {
  return <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", openClass)} />;
}

/** A row's trigger with how long its calls took beside it, shown while
 *  the row is hovered or focused (always on touch screens). The duration
 *  sits outside the trigger so it isn't part of the button's name, and
 *  keeps its width while hidden so the row doesn't shift; a long label
 *  truncates before it. Nothing until every call has finished. */
function ToolRow({
  tools,
  testId,
  children,
}: {
  tools: ToolEntry[];
  testId: string;
  children: ReactNode;
}) {
  const ms = toolDuration(tools);
  return (
    <div className="group/tool-row flex max-w-full min-w-0 items-center gap-1.5 text-sm">
      {children}
      {ms !== undefined && (
        <span
          data-testid={testId}
          className="shrink-0 tabular-nums text-muted-foreground/70 opacity-0 transition-opacity group-hover/tool-row:opacity-100 group-has-[:focus-visible]/tool-row:opacity-100 [@media(hover:none)]:opacity-100"
        >
          {formatToolDuration(ms)}
        </span>
      )}
    </div>
  );
}

function Label({ label }: { label: ToolLabel }) {
  const at = label.highlight ? label.text.indexOf(label.highlight) : -1;
  if (!label.highlight || at < 0) return <>{label.text}</>;
  return (
    <>
      {label.text.slice(0, at)}
      <span className="text-foreground">{label.highlight}</span>
      {label.text.slice(at + label.highlight.length)}
    </>
  );
}

/** A shell call: the command, then the exit code and output. Parsed only
 *  once expanded, so a collapsed row never scans the output. */
function ShellDetails({ entry, failed }: { entry: ToolEntry; failed: boolean }) {
  const run = useMemo(() => shellRun(entry), [entry]);
  if (!run) return null;
  const showExit = run.exitCode !== undefined && (failed || run.exitCode !== 0);
  return (
    <div className={cn("space-y-2 font-mono text-xs", failed && "text-red-400")}>
      <pre
        data-testid="tool-call__command"
        className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-foreground"
      >
        <span className="select-none text-muted-foreground">$ </span>
        {run.command}
      </pre>
      {showExit && <div data-testid="tool-call__exit-code">Exit code {run.exitCode}</div>}
      {run.output && (
        <pre
          data-testid="tool-call__output"
          className={cn(
            "max-h-80 overflow-auto whitespace-pre-wrap",
            !failed && "text-muted-foreground",
          )}
        >
          {run.output.slice(0, OUTPUT_LIMIT)}
        </pre>
      )}
    </div>
  );
}

/** What the agent reported for any other call: diffs, text, raw input and output. */
function ToolDetails({ entry, cwd }: { entry: ToolEntry; cwd?: string }) {
  const diffs = entry.content.filter((c) => c.type === "diff");
  const texts = entry.content.flatMap((c) =>
    c.type === "content" && c.content.type === "text" ? [c.content.text] : [],
  );
  // Plans and thinking come back as prose; command output is raw text.
  const prose = entry.toolKind === "switch_mode" || entry.toolKind === "think";
  return (
    <>
      {diffs.map((d) => (
        <Diff key={d.path} path={d.path} oldText={d.oldText} newText={d.newText} cwd={cwd} />
      ))}
      {texts.map((text, i) =>
        prose ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: content blocks have no id
          <MessageResponse key={i}>{text}</MessageResponse>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: content blocks have no id
          <ToolOutput key={i} output={text.slice(0, 20_000)} errorText={undefined} />
        ),
      )}
      {diffs.length === 0 && texts.length === 0 && entry.rawInput !== undefined && (
        <ToolInput input={entry.rawInput} />
      )}
      {diffs.length === 0 && texts.length === 0 && entry.rawOutput !== undefined && (
        <ToolOutput output={entry.rawOutput} errorText={undefined} />
      )}
    </>
  );
}

/**
 * One ACP tool call as one line: a short description, red when it failed.
 * Expanding it shows a shell call's command, exit code and output, or
 * whatever else the agent reported (diffs, text, raw input and output).
 */
export const ToolCall = memo(function ToolCall({ entry, cwd }: { entry: ToolEntry; cwd?: string }) {
  const state = toolState(entry);
  const failed = state === "error";
  const shell = entry.toolKind === "execute";
  const hasBody =
    shell ||
    entry.content.some(
      (c) => c.type === "diff" || (c.type === "content" && c.content.type === "text"),
    ) ||
    entry.rawInput !== undefined ||
    entry.rawOutput !== undefined;

  return (
    <Collapsible
      data-testid="tool-call__container"
      data-status={state}
      className="group/tool-call not-prose w-full min-w-0"
    >
      <ToolRow tools={[entry]} testId="tool-call__duration">
        <CollapsibleTrigger
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-left",
            failed ? "text-red-400" : "text-muted-foreground",
            hasBody && (failed ? "hover:text-red-300" : "hover:text-foreground"),
          )}
          disabled={!hasBody}
        >
          <span
            data-testid="tool-call__label"
            className={cn("truncate", state === "in-progress" && "tool-shimmer")}
          >
            <Label label={describeTool(entry)} />
          </span>
          {hasBody && <Chevron openClass="group-data-[state=open]/tool-call:rotate-90" />}
        </CollapsibleTrigger>
      </ToolRow>

      <CollapsibleContent className="mt-2 space-y-3 text-popover-foreground">
        {shell ? (
          <ShellDetails entry={entry} failed={failed} />
        ) : (
          <ToolDetails entry={entry} cwd={cwd} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
});

/**
 * Consecutive tool calls folded into one summary line. Expanded, each call
 * is its own row; `children` renders the group's entries (calls and any
 * thinking between them), one row each.
 */
export const ToolGroup = memo(function ToolGroup({
  tools,
  children,
}: {
  tools: ToolEntry[];
  children: ReactNode;
}) {
  const running = tools.some((t) => toolState(t) === "in-progress");
  return (
    <Collapsible
      data-testid="tool-group__container"
      className="group/tool-group not-prose w-full min-w-0"
    >
      <ToolRow tools={tools} testId="tool-group__duration">
        <CollapsibleTrigger
          data-testid="tool-group__summary"
          className="flex min-w-0 items-center gap-1.5 text-left text-muted-foreground hover:text-foreground"
        >
          <span className={cn("truncate", running && "tool-shimmer")}>{summarizeTools(tools)}</span>
          <Chevron openClass="group-data-[state=open]/tool-group:rotate-90" />
        </CollapsibleTrigger>
      </ToolRow>
      <CollapsibleContent className="mt-2 divide-y divide-border/40 overflow-hidden rounded-lg border border-border/40 [&>*]:px-3 [&>*]:py-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
});
