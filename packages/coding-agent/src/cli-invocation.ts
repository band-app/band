import { execFileSync } from "node:child_process";
import {
  CLAUDE_CODE_DEFAULT_BINARY,
  CODEX_DEFAULT_BINARY,
  GEMINI_CLI_DEFAULT_BINARY,
  OPENCODE_DEFAULT_BINARY,
} from "./install-skills.ts";
import type { CliInvocation } from "./types.ts";

/**
 * Per-call options shared by the invocation resolvers below.
 *
 * `command` is the agent definition's `command` field from
 * `settings.codingAgents` — a user-configured path/name for the vendor
 * binary. When absent each agent falls back to its default binary name.
 */
export interface CliInvocationOptions {
  command?: string;
}

/**
 * Resolve the `codex` binary from the system PATH, once per process.
 *
 * Matches the retired Codex adapter, which used the server's `which codex`
 * result (an absolute path) as its binary when no `command` was configured.
 * The lookup blocks the event loop for 1–10 ms, so it runs lazily once per
 * process: PATH doesn't change mid-process.
 */
let cachedCodexBinary: string | null | undefined;
function resolveCodexBinary(): string | undefined {
  if (cachedCodexBinary === undefined) {
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      cachedCodexBinary = execFileSync(cmd, ["codex"], { encoding: "utf-8" }).trim() || null;
    } catch {
      cachedCodexBinary = null;
    }
  }
  return cachedCodexBinary ?? undefined;
}

/**
 * Binary for a supported `agentType`: the definition's `command`, else the
 * agent's default name. Only called from the supported-type branches below.
 */
function binary(agentType: string, opts: CliInvocationOptions | undefined): string {
  if (opts?.command) return opts.command;
  switch (agentType) {
    case "claude-code":
      return CLAUDE_CODE_DEFAULT_BINARY;
    case "codex":
      return resolveCodexBinary() ?? CODEX_DEFAULT_BINARY;
    case "gemini-cli":
      return GEMINI_CLI_DEFAULT_BINARY;
    default:
      return OPENCODE_DEFAULT_BINARY;
  }
}

function unknownAgent(agentType: string): CliInvocation {
  return { unsupported: true, reason: `Unknown coding agent type: ${agentType}` };
}

/**
 * Resolve the one-shot CLI invocation for spawning `agentType` in an
 * interactive terminal pane with `prompt` pre-loaded (cmux-style, e.g.
 * `claude "Implement X"`).
 *
 * Powers `workspaces.create --via terminal` (issue #551). The server passes
 * the returned `command + args` to `terminalService.spawn`, which composes a
 * shell-escaped command line inside the workspace's PTY.
 *
 * Agents whose vendor binary has no usable interactive mode (`cursor-cli`)
 * and unknown agent types return `{ unsupported: true, reason }`; the
 * workspace service then warns and falls back to the chat path.
 */
export function cliInvocation(
  agentType: string,
  prompt: string,
  opts?: CliInvocationOptions,
): CliInvocation {
  switch (agentType) {
    case "claude-code":
    case "codex":
      // First positional is the prompt: `claude "<prompt>"`, `codex "<prompt>"`.
      return { command: binary(agentType, opts), args: [prompt] };
    case "gemini-cli":
      // The end-of-options `--` prevents a prompt that starts with `-` from
      // being parsed as a flag by the Gemini binary.
      return { command: binary(agentType, opts), args: ["--", prompt] };
    case "opencode":
      // The OpenCode TUI's positional is a *project path* (`opencode
      // [project]`), so the prompt goes through the dedicated `--prompt` flag.
      return { command: binary(agentType, opts), args: ["--prompt", prompt] };
    case "cursor-cli":
      return {
        unsupported: true,
        reason: "Cursor CLI has no interactive prompt-loading invocation; falling back to chat.",
      };
    default:
      return unknownAgent(agentType);
  }
}

/**
 * Resolve the *headless* (non-interactive) one-shot CLI invocation for
 * `prompt` — the vendor CLI's "run this and exit" mode.
 *
 * Distinct from {@link cliInvocation}, which opens the interactive REPL and
 * never exits on its own. This variant powers cronjobs with `via: "terminal"`
 * (issue #581), where the pane must run to completion and exit so the
 * terminal self-closes and the scheduler can tell "still running" from
 * "done".
 */
export function cliHeadlessInvocation(
  agentType: string,
  prompt: string,
  opts?: CliInvocationOptions,
): CliInvocation {
  switch (agentType) {
    case "claude-code":
      // The prompt is the value of `-p`, so a leading `-` in it is consumed
      // as the flag's argument rather than parsed as a flag.
      return { command: binary(agentType, opts), args: ["-p", prompt] };
    case "codex":
      return { command: binary(agentType, opts), args: ["exec", prompt] };
    case "gemini-cli":
      // The joined `--prompt=<value>` form binds the prompt as the flag's
      // argument even when it starts with `-`. `--output-format` is omitted:
      // a cron terminal shows plain human-readable output.
      return { command: binary(agentType, opts), args: [`--prompt=${prompt}`] };
    case "opencode":
      return { command: binary(agentType, opts), args: ["run", prompt] };
    case "cursor-cli":
      return {
        unsupported: true,
        reason: "Cursor CLI has no non-interactive CLI invocation; falling back to chat.",
      };
    default:
      return unknownAgent(agentType);
  }
}

/**
 * Resolve the CLI invocation that *resumes* an existing agent session in an
 * interactive terminal pane. Powers the chat tab's "Continue in terminal"
 * action.
 *
 * Gemini CLI has no session model and Cursor CLI has no by-id resume CLI, so
 * both return `{ unsupported: true, reason }`; callers surface the reason
 * instead of spawning a useless terminal.
 */
export function resumeCliInvocation(
  agentType: string,
  sessionId: string,
  opts?: CliInvocationOptions,
): CliInvocation {
  switch (agentType) {
    case "claude-code":
      // Session-ID lookup is scoped to the project directory + its
      // worktrees, which is where the PTY is spawned.
      return { command: binary(agentType, opts), args: ["--resume", sessionId] };
    case "codex":
      return { command: binary(agentType, opts), args: ["resume", sessionId] };
    case "opencode":
      return { command: binary(agentType, opts), args: ["--session", sessionId] };
    case "gemini-cli":
      return { unsupported: true, reason: "Gemini CLI has no session-resume invocation." };
    case "cursor-cli":
      return {
        unsupported: true,
        reason: "Cursor CLI has no interactive session-resume invocation.",
      };
    default:
      return unknownAgent(agentType);
  }
}
