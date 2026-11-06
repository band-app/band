/**
 * Quick commands on the phone: the pure parts. The hub stores them (`quickCommands.*`), scoped to
 * all repos or one repo, most recently run first. The worktree screen lists the ones for its repo,
 * runs a Terminal command in a new terminal tab and starts an Agent command as a chat.
 */

export const LABEL_MAX = 80;
export const TEXT_MAX = 4000;

export type QuickCommand = {
  id: string;
  label: string;
  /** The repo name, or null for a command available in every repo. */
  repo: string | null;
  lastRunAt: number | null;
} & (
  | { action: "terminal"; command: string; appendEnter: boolean }
  | { action: "agent"; agentId: string; prompt: string }
);

export type QuickCommandInput =
  | {
      label: string;
      repo: string | null;
      action: "terminal";
      command: string;
      appendEnter: boolean;
    }
  | { label: string; repo: string | null; action: "agent"; agentId: string; prompt: string };

/** What the add and edit form holds. */
export interface QuickCommandDraft {
  label: string;
  action: "terminal" | "agent";
  /** The command for Terminal, the prompt for Agent. */
  body: string;
  appendEnter: boolean;
  agentId: string;
  /** True for a command that only this worktree's repo lists. */
  thisRepoOnly: boolean;
}

/** The commands a worktree of `repo` lists: global ones plus its repo's, in the hub's order. */
export function commandsForRepo(all: readonly QuickCommand[], repo: string): QuickCommand[] {
  return all.filter((c) => c.repo === null || c.repo === repo);
}

/** Why the draft can't be saved yet, or null when it can. */
export function draftProblem(draft: QuickCommandDraft): string | null {
  if (!draft.label.trim()) return "Add a label.";
  if (draft.label.length > LABEL_MAX) return `The label can be at most ${LABEL_MAX} characters.`;
  const noun = draft.action === "terminal" ? "command" : "prompt";
  if (!draft.body.trim()) return `Add a ${noun}.`;
  if (draft.body.length > TEXT_MAX) return `The ${noun} can be at most ${TEXT_MAX} characters.`;
  if (draft.action === "agent" && !draft.agentId) return "Pick an agent.";
  return null;
}

/** The `quickCommands.create` input for a draft opened from a worktree of `repo`. */
export function draftToInput(draft: QuickCommandDraft, repo: string): QuickCommandInput {
  const base = { label: draft.label.trim(), repo: draft.thisRepoOnly ? repo : null };
  return draft.action === "terminal"
    ? { ...base, action: "terminal", command: draft.body, appendEnter: draft.appendEnter }
    : { ...base, action: "agent", agentId: draft.agentId, prompt: draft.body };
}

/** The form's starting values: a blank draft, or the command being edited. */
export function draftFor(
  command: QuickCommand | undefined,
  defaultAgentId: string,
): QuickCommandDraft {
  if (!command) {
    return {
      label: "",
      action: "terminal",
      body: "",
      appendEnter: true,
      agentId: defaultAgentId,
      thisRepoOnly: true,
    };
  }
  return command.action === "terminal"
    ? {
        label: command.label,
        action: "terminal",
        body: command.command,
        appendEnter: command.appendEnter,
        agentId: defaultAgentId,
        thisRepoOnly: command.repo !== null,
      }
    : {
        label: command.label,
        action: "agent",
        body: command.prompt,
        appendEnter: true,
        agentId: command.agentId,
        thisRepoOnly: command.repo !== null,
      };
}

/**
 * How a Terminal command starts in a new terminal. With Enter the shell runs `command` as it
 * starts. Without, the shell starts empty and `typeText` is written at its prompt.
 */
export function terminalStart(command: { command: string; appendEnter: boolean }): {
  command?: string;
  typeText?: string;
} {
  return command.appendEnter ? { command: command.command } : { typeText: command.command };
}

/** One line under a command's label: the text, or the agent and its prompt. */
export function commandSummary(command: QuickCommand, agentLabel: (id: string) => string): string {
  const text =
    command.action === "terminal"
      ? command.command
      : `${agentLabel(command.agentId)}: ${command.prompt}`;
  return text.replace(/\s+/g, " ").trim();
}
