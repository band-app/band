/** Why a chat's agent failed. The hub classifies it, the chat renders it as a card. */
export type AgentFailureCause =
  | "killed"
  | "exit"
  | "auth"
  | "limit"
  | "disconnected"
  | "timeout"
  | "unknown";

export interface AgentFailure {
  cause: AgentFailureCause;
  exitCode: number | null;
  /** Signal name such as `SIGKILL`, or `link-lost` when the worker link dropped. */
  signal: string | null;
  /** Id of the host the agent ran on. */
  host: string;
  sessionId: string | null;
  /** The agent's display name, such as "Claude Code". */
  agent: string;
  /** Epoch milliseconds. */
  at: number;
  /** The last 4 KB of the agent's stderr, untouched. */
  stderrTail: string;
  /** The text older clients show: the error message with the stderr appended. */
  message: string;
  /** The last non-noise stderr line (cause `exit`), or the reset time (cause `limit`). */
  detail?: string;
  /** Milliseconds from the turn's start to the failure, when known. */
  turnMs?: number;
}

export interface FailureInput {
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  message: string;
  timedOut?: boolean;
}

const AUTH =
  /\b(?:http|status(?: code)?)\W{0,3}401\b|"status":\s*401|unauthorized|not logged in|please run \/login|invalid api key|invalid x-api-key/i;
const LIMIT =
  /usage limit|rate limit|rate_limit|\b(?:http|status(?: code)?)\W{0,3}429\b|"status":\s*429|too many requests/i;
const RESET =
  /resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|[A-Z][a-z]{2,8}\s+\d{1,2}[^.\n]*)/i;

/** Lines that explain nothing about a failure. Kept in one list so the card
 *  and the cause line agree on what "relevant" means. */
const NOISE: { test: RegExp; label: string }[] = [
  { test: /^\[session\/create\].*\bphase=/, label: "startup timings" },
  { test: /^\[session\/query\]/, label: "startup timings" },
  { test: /CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/, label: "SDK warnings" },
  { test: /^Unexpected case: \{"type":"system"/, label: "system events" },
  { test: /trailing-idle debt/, label: "idle notices" },
];

const ERROR_LINE = /error|exception|fatal|killed|ENOSPC|ENOMEM/i;

export function isNoiseLine(line: string): boolean {
  const t = line.trim();
  return NOISE.some((n) => n.test.test(t));
}

export function isErrorLine(line: string): boolean {
  return ERROR_LINE.test(line);
}

export interface FilteredOutput {
  lines: { text: string; error: boolean }[];
  /** How many lines "Relevant" hides, with the kinds they belong to. */
  hidden: number;
  hiddenKinds: string[];
}

/** Splits the stderr tail into lines for the details block. `relevant` drops
 *  the known noise and says how much it dropped. */
export function filterOutput(stderr: string, relevant: boolean): FilteredOutput {
  const lines: FilteredOutput["lines"] = [];
  const kinds = new Set<string>();
  let hidden = 0;
  for (const raw of stderr.replace(/\s+$/, "").split("\n")) {
    if (raw.trim() === "") continue;
    const noise = NOISE.find((n) => n.test.test(raw.trim()));
    if (relevant && noise) {
      hidden++;
      kinds.add(noise.label);
      continue;
    }
    lines.push({ text: raw, error: isErrorLine(raw) });
  }
  return { lines, hidden, hiddenKinds: [...kinds] };
}

/** The last stderr line that is not noise, trimmed to one line. */
export function lastRelevantLine(stderr: string): string | undefined {
  const lines = stderr.split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && !isNoiseLine(line)) return line.length > 200 ? `${line.slice(0, 199)}…` : line;
  }
  return undefined;
}

const AMBER_CAUSES: AgentFailureCause[] = ["auth", "limit", "disconnected"];

/** `amber` for a problem the user can fix outside Band, `red` otherwise. */
export function failureTone(cause: AgentFailureCause): "red" | "amber" {
  return AMBER_CAUSES.includes(cause) ? "amber" : "red";
}

/** Decides the cause from the exit and a few known patterns in stderr. */
export function classifyFailure(input: FailureInput): {
  cause: AgentFailureCause;
  detail?: string;
} {
  const { exitCode, signal, stderr, message } = input;
  // Noise lines carry timings such as `durationMs=401`, so they can't decide the cause.
  const text = `${stderr}\n${message}`
    .split("\n")
    .filter((l) => !isNoiseLine(l))
    .join("\n");
  if (signal === "link-lost") return { cause: "disconnected" };
  if (AUTH.test(text)) return { cause: "auth" };
  if (LIMIT.test(text)) {
    const reset = RESET.exec(text)?.[1]?.trim();
    return { cause: "limit", ...(reset && { detail: reset }) };
  }
  if (signal === "SIGKILL" || signal === "SIGTERM") return { cause: "killed" };
  if (input.timedOut) return { cause: "timeout" };
  if (exitCode !== null && exitCode !== 0) {
    const detail = lastRelevantLine(stderr);
    return { cause: "exit", ...(detail && { detail }) };
  }
  return { cause: "unknown" };
}

/** What the card says. `hostLabel` is the host's display name. */
export function describeFailure(
  f: Pick<AgentFailure, "cause" | "exitCode" | "signal" | "agent" | "detail">,
  hostLabel: string,
): { headline: string; line: string } {
  switch (f.cause) {
    case "killed":
      return {
        headline: `${f.agent} stopped unexpectedly`,
        line: `Killed by ${f.signal} on ${hostLabel}${
          f.signal === "SIGKILL" ? ", likely out of memory" : ""
        }. Your next message starts it again and resumes the session.`,
      };
    case "exit":
      return {
        headline: `${f.agent} exited with code ${f.exitCode}`,
        line: f.detail ? `Last line: ${f.detail}` : `It exited on ${hostLabel} without saying why.`,
      };
    case "auth":
      return {
        headline: `${f.agent} isn't logged in on ${hostLabel}`,
        line: "The agent was refused (401 or an invalid key). Log in on that worker, then retry.",
      };
    case "limit":
      return {
        headline: "Usage limit reached",
        line: f.detail
          ? `The limit resets at ${f.detail}.`
          : "The agent reported a usage or rate limit.",
      };
    case "disconnected":
      return {
        headline: `Lost the connection to ${hostLabel}`,
        line: "The worker went offline mid-turn. The agent may still be running there; Band reconnects when the worker is back.",
      };
    case "timeout":
      return {
        headline: `${f.agent} didn't answer`,
        line: "The agent did not answer a request in time. Retry, or restart the agent.",
      };
    default:
      return {
        headline: `${f.agent} stopped`,
        line: "The agent failed and Band could not tell why. The details have what it printed.",
      };
  }
}

/** A failure made from an older event that carried only a string. */
export function failureFromMessage(message: string): AgentFailure {
  return {
    cause: "unknown",
    exitCode: null,
    signal: null,
    host: "",
    sessionId: null,
    agent: "The agent",
    at: 0,
    stderrTail: message,
    message,
  };
}
