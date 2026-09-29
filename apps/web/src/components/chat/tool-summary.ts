/**
 * How the chat pane shows tool calls: consecutive calls fold into one
 * group with a one-line summary ("Ran 17 commands (1 failed), read
 * package.json"), each call in it gets a short description, and a shell
 * call's command, exit code and output are pulled out of whatever shape
 * the agent reported them in.
 *
 * Pure, like `transcript.ts`: the renderer calls these on every render.
 */

import type { ToolKind } from "@agentclientprotocol/sdk";
import type { Entry, ToolEntry } from "./transcript";

/** One item in an assistant message: an entry on its own, or a run of
 *  tool calls (with any thinking between them) shown as one group. */
export type MessagePart =
  | { kind: "entry"; entry: Entry }
  | { kind: "tools"; id: string; entries: Entry[]; tools: ToolEntry[] };

function blank(entry: Entry): boolean {
  return entry.kind === "text" && !entry.text.trim();
}

/**
 * Splits an assistant message's entries into parts. A run of two or more
 * tool calls becomes one group; thinking and empty text between them stay
 * in the group, thinking before the first or after the last call doesn't.
 */
export function groupEntries(entries: Entry[]): MessagePart[] {
  const parts: MessagePart[] = [];
  let run: Entry[] = [];

  const flush = () => {
    // Trim to the first and last tool call.
    const first = run.findIndex((e) => e.kind === "tool");
    let last = run.length - 1;
    while (last >= 0 && run[last].kind !== "tool") last--;
    const tools = run.filter((e): e is ToolEntry => e.kind === "tool");
    if (tools.length < 2) {
      for (const entry of run) parts.push({ kind: "entry", entry });
    } else {
      for (const entry of run.slice(0, first)) parts.push({ kind: "entry", entry });
      parts.push({
        kind: "tools",
        id: `group-${tools[0].id}`,
        entries: run.slice(first, last + 1).filter((e) => !blank(e)),
        tools,
      });
      for (const entry of run.slice(last + 1)) parts.push({ kind: "entry", entry });
    }
    run = [];
  };

  for (const entry of entries) {
    if (entry.kind === "tool" || entry.kind === "thought" || blank(entry)) {
      run.push(entry);
    } else {
      flush();
      parts.push({ kind: "entry", entry });
    }
  }
  flush();
  return parts;
}

export type ToolState = "error" | "in-progress" | "complete";

export function toolState(entry: ToolEntry): ToolState {
  if (entry.status === "failed") return "error";
  if (entry.status === "pending" || entry.status === "in_progress") return "in-progress";
  return "complete";
}

/** How long the calls ran, from the first start to the last end (ms).
 *  Undefined while one runs or when a call has no times. */
export function toolDuration(tools: ToolEntry[]): number | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const t of tools) {
    if (t.startedAt === undefined || t.endedAt === undefined) return undefined;
    start = Math.min(start, t.startedAt);
    end = Math.max(end, t.endedAt);
  }
  return tools.length > 0 ? Math.max(0, end - start) : undefined;
}

/** "340ms", "4.2s", "42s", "3m 5s". */
export function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** The part of the call's first path that its title shows, e.g.
 *  `src/app.ts` in "Read src/app.ts (1 - 20)". */
function pathInTitle(entry: ToolEntry): string | undefined {
  const path = entry.locations[0]?.path;
  if (!path) return undefined;
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    const tail = segments.slice(i).join("/");
    if (tail && entry.title.includes(tail)) return tail;
  }
  return undefined;
}

/** Claude Code's shell tools send a one-line description of the command
 *  ("Install dependencies") beside the command itself. */
function shellDescription(entry: ToolEntry): string | undefined {
  const description = record(entry.rawInput)?.description;
  return typeof description === "string" && description.trim() ? description.trim() : undefined;
}

export interface ToolLabel {
  text: string;
  /** A substring of `text` to show in full contrast (the file path). */
  highlight?: string;
}

/** The row text for one call: its description, or its title. */
export function describeTool(entry: ToolEntry): ToolLabel {
  const description = shellDescription(entry);
  if (description) {
    return toolState(entry) === "error"
      ? { text: `Failed to ${description[0].toLowerCase()}${description.slice(1)}` }
      : { text: description };
  }
  return { text: entry.title, highlight: pathInTitle(entry) };
}

interface Phrase {
  one: (entry: ToolEntry) => string;
  many: (n: number) => string;
}

function fileNamed(verb: string, noun = "file"): Phrase {
  return {
    one: (entry) => {
      const path = entry.locations[0]?.path;
      return path ? `${verb} ${basename(path)}` : `${verb} 1 ${noun}`;
    },
    many: (n) => `${verb} ${n} ${noun}s`,
  };
}

const counted = (verb: string, noun: string): Phrase => ({
  one: () => `${verb} 1 ${noun}`,
  many: (n) => `${verb} ${n} ${noun}s`,
});

const PHRASES: Partial<Record<ToolKind, Phrase>> = {
  execute: counted("ran", "command"),
  read: fileNamed("read"),
  edit: fileNamed("edited"),
  delete: fileNamed("deleted"),
  move: fileNamed("moved"),
  search: { one: () => "ran 1 search", many: (n) => `ran ${n} searches` },
  fetch: counted("fetched", "page"),
  think: counted("ran", "task"),
};

const OTHER: Phrase = counted("used", "tool");

/**
 * One line for a group, one clause per kind of call in the order they
 * first ran: "Ran 17 commands (1 failed), read package.json".
 */
export function summarizeTools(tools: ToolEntry[]): string {
  const byPhrase = new Map<Phrase, ToolEntry[]>();
  for (const tool of tools) {
    const phrase = (tool.toolKind && PHRASES[tool.toolKind]) || OTHER;
    const list = byPhrase.get(phrase);
    if (list) list.push(tool);
    else byPhrase.set(phrase, [tool]);
  }
  const clauses = [...byPhrase].map(([phrase, list]) => {
    const text = list.length === 1 ? phrase.one(list[0]) : phrase.many(list.length);
    const failed = list.filter((t) => toolState(t) === "error").length;
    return failed > 0 ? `${text} (${failed} failed)` : text;
  });
  const line = clauses.join(", ");
  return line[0].toUpperCase() + line.slice(1);
}

export interface ShellRun {
  command: string;
  exitCode?: number;
  output: string;
}

/** How much of a command's output the chat pane shows. */
export const OUTPUT_LIMIT = 20_000;

/** The code fence agents wrap output in for display. Matched as two ends,
 *  because a long output is cut before its closing fence. */
const FENCE_OPEN = /^```[\w-]*\n/;
const FENCE_CLOSE = /\n?```\s*$/;
/** Claude Code starts a failed command's output with its exit code. */
const EXIT_LINE = /^Exit code (\d+)\n?/;

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rawOutputText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const out = record(raw);
  if (!out) return "";
  for (const key of ["formatted_output", "aggregated_output", "output"]) {
    if (typeof out[key] === "string") return out[key] as string;
  }
  return [out.stdout, out.stderr].filter((s) => typeof s === "string" && s).join("\n");
}

/**
 * A shell call's command, exit code and output. Claude Code sends the
 * command in `rawInput.command` and the output as fenced text content,
 * starting with "Exit code N" when the command failed; Codex sends
 * `rawOutput.formatted_output` and `rawOutput.exit_code`. Returns null
 * for calls that aren't shell commands.
 */
export function shellRun(entry: ToolEntry): ShellRun | null {
  if (entry.toolKind !== "execute") return null;
  const input = record(entry.rawInput);
  const cmd = input?.command;
  const command =
    typeof cmd === "string"
      ? cmd
      : Array.isArray(cmd) && cmd.every((c) => typeof c === "string")
        ? cmd.join(" ")
        : entry.title;

  const texts = entry.content.flatMap((c) =>
    c.type === "content" && c.content.type === "text" ? [c.content.text] : [],
  );
  // Only the first 20k characters are shown; don't parse megabytes of
  // output to show them.
  let output = (texts.length > 0 ? texts.join("\n") : rawOutputText(entry.rawOutput)).slice(
    0,
    OUTPUT_LIMIT + 64,
  );
  if (FENCE_OPEN.test(output)) output = output.replace(FENCE_OPEN, "").replace(FENCE_CLOSE, "");
  // Before the command finishes, Claude Code's content is the description.
  if (output === shellDescription(entry)) output = "";

  const raw = record(entry.rawOutput);
  let exitCode = number(raw?.exit_code) ?? number(raw?.exitCode);
  const exitLine = EXIT_LINE.exec(output);
  if (exitLine) {
    exitCode ??= Number(exitLine[1]);
    output = output.slice(exitLine[0].length);
  }
  return { command, exitCode, output: output.trimEnd() };
}
