/**
 * Quick commands: text a person saves once and runs with one tap in a worktree. A terminal command
 * is typed into a terminal, an agent command starts an agent with a prompt. Scope is global or one
 * repo by name. Running happens in the client, which calls `terminal.create` or
 * `agentSessions.launch`; the hub stores the commands and when each last ran.
 */

import { randomBytes } from "node:crypto";
import { QuickCommandInvalidError, QuickCommandNotFoundError } from "../errors";
import { QuickCommandQueries, type QuickCommandRow } from "../infra/db/queries/quick-commands";
import { RepoQueries } from "../infra/db/queries/repos";
import { SettingsQueries } from "../infra/db/queries/settings";

export const QUICK_COMMAND_LABEL_MAX = 80;
export const QUICK_COMMAND_TEXT_MAX = 4000;

export type QuickCommandInput =
  | {
      label: string;
      repo: string | null;
      action: "terminal";
      command: string;
      appendEnter: boolean;
    }
  | { label: string; repo: string | null; action: "agent"; agentId: string; prompt: string };

export type QuickCommand = {
  id: string;
  label: string;
  /** Repo name, or null for a global command. */
  repo: string | null;
  lastRunAt: number | null;
} & (
  | { action: "terminal"; command: string; appendEnter: boolean }
  | { action: "agent"; agentId: string; prompt: string }
);

function toCommand(row: QuickCommandRow): QuickCommand {
  const base = { id: row.id, label: row.label, repo: row.repoName, lastRunAt: row.lastRunAt };
  return row.action === "agent"
    ? { ...base, action: "agent", agentId: row.agentId ?? "", prompt: row.prompt }
    : { ...base, action: "terminal", command: row.command, appendEnter: row.appendEnter };
}

export class QuickCommandService {
  constructor(
    private readonly queries: QuickCommandQueries = new QuickCommandQueries(),
    private readonly repos: RepoQueries = new RepoQueries(),
    private readonly settings: SettingsQueries = new SettingsQueries(),
  ) {}

  /** Most recently run first, then by label. */
  list(): QuickCommand[] {
    return this.queries
      .list()
      .map(toCommand)
      .sort(
        (a, b) =>
          (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) ||
          a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
      );
  }

  create(input: QuickCommandInput): QuickCommand {
    const row = this.toRow(input);
    const full: QuickCommandRow = {
      ...row,
      id: `qc-${randomBytes(6).toString("hex")}`,
      lastRunAt: null,
      createdAt: Date.now(),
    };
    this.queries.insert(full);
    return toCommand(full);
  }

  update(id: string, input: QuickCommandInput): QuickCommand {
    this.require(id);
    this.queries.update(id, this.toRow(input));
    return toCommand(this.require(id));
  }

  remove(id: string): void {
    this.require(id);
    this.queries.remove(id);
  }

  /** Records that a person ran the command, which moves it to the top of the menus. */
  markRun(id: string): void {
    this.require(id);
    this.queries.update(id, { lastRunAt: Date.now() });
  }

  removeForRepo(repoName: string): void {
    this.queries.removeForRepo(repoName);
  }

  private require(id: string): QuickCommandRow {
    const row = this.queries.find(id);
    if (!row) throw new QuickCommandNotFoundError(id);
    return row;
  }

  private toRow(input: QuickCommandInput) {
    const label = input.label.trim();
    if (!label) throw new QuickCommandInvalidError("Label is required");
    if (label.length > QUICK_COMMAND_LABEL_MAX) {
      throw new QuickCommandInvalidError(
        `Label can be at most ${QUICK_COMMAND_LABEL_MAX} characters`,
      );
    }
    if (input.repo !== null && !this.repos.loadAll().some((r) => r.name === input.repo)) {
      throw new QuickCommandInvalidError(`Unknown repo: ${input.repo}`);
    }
    if (input.action === "terminal") {
      if (!input.command.trim()) throw new QuickCommandInvalidError("Command is required");
      if (input.command.length > QUICK_COMMAND_TEXT_MAX) {
        throw new QuickCommandInvalidError(
          `Command can be at most ${QUICK_COMMAND_TEXT_MAX} characters`,
        );
      }
      return {
        label,
        repoName: input.repo,
        action: "terminal",
        command: input.command,
        appendEnter: input.appendEnter,
        agentId: null,
        prompt: "",
      };
    }
    if (!input.prompt.trim()) throw new QuickCommandInvalidError("Prompt is required");
    if (input.prompt.length > QUICK_COMMAND_TEXT_MAX) {
      throw new QuickCommandInvalidError(
        `Prompt can be at most ${QUICK_COMMAND_TEXT_MAX} characters`,
      );
    }
    const agents = this.settings.load().codingAgents ?? [];
    if (!agents.some((a) => a.id === input.agentId)) {
      throw new QuickCommandInvalidError(`Unknown agent: ${input.agentId}`);
    }
    return {
      label,
      repoName: input.repo,
      action: "agent",
      command: "",
      appendEnter: true,
      agentId: input.agentId,
      prompt: input.prompt,
    };
  }
}

export const quickCommandService = new QuickCommandService();
