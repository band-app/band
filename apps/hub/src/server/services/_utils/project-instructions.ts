/**
 * The default `AGENTS.md` of a project: what its coordinator does, its tools, and the autonomy and
 * policy it started with. It is written once into the project's context repo when the project is
 * created, then belongs to the user, who edits it in the project folder. Claude Code reads
 * `CLAUDE.md`, which holds only an import of this file. The hub enforces the policy in the
 * `band-coordinator` tools, so the text here describes the limits and does not enforce them.
 */

import { COORDINATOR_SERVER, type ResolvedPolicy } from "./project-policy";

export const INSTRUCTIONS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";
export const CLAUDE_TEXT = `@${INSTRUCTIONS_FILE}\n`;

export interface InstructionsInput {
  name: string;
  description: string;
  contextName: string;
  repos: Array<{ repo: string; role?: string | null }>;
  policy: ResolvedPolicy;
}

export function defaultInstructions(view: InstructionsInput): string {
  const p = view.policy;
  const repos = view.repos
    .map((r) => `- \`${r.repo}\`${r.role ? ` (role: ${r.role})` : ""}`)
    .join("\n");
  const limits = [
    p.maxConcurrent
      ? `at most ${p.maxConcurrent} worker agents run at once`
      : "no limit on concurrent worker agents",
    p.budgetUsd ? `a soft budget of $${p.budgetUsd} for the project` : "no budget limit",
    `worker agents run at isolation "${p.isolationFloor}" or stronger`,
    p.labels.length
      ? `workers go only on hosts labeled ${p.labels.join(", ")}`
      : "workers may go on any host",
  ].join("; ");
  const autonomy =
    p.autonomy === "observe"
      ? "Autonomy is observe. You may read project state and worker chats. You may not message, stop or dispatch anything. Report what you find and recommend actions to the user."
      : p.autoMerge
        ? "Autonomy is autonomous with auto-merge on. You may dispatch workers within the limits and merge pull requests whose CI passed."
        : "Autonomy is autonomous. You may dispatch workers within the limits. Merging still needs the user's confirmation.";
  const folderEdits =
    p.autonomy === "autonomous"
      ? "When the user asks for such an edit, you may commit it, and you may push it because autonomy is autonomous."
      : `When the user asks for such an edit, commit it but do not push without the user's confirmation, because autonomy is ${p.autonomy}.`;
  return `${[
    `# Coordinator of the Band project "${view.name}"`,
    view.description ? `Project description: ${view.description}` : "",
    "You coordinate this project. Plan the work across the project's repos, hand it to worker agents, check on them and keep the user informed. Each worker agent works in one git worktree of one repo, with its own chat. Work that spans repos takes one worker per repo, and you keep them in step.",
    "This file is yours and the user's to edit. It started from the project's settings at creation. The Band hub enforces the limits below in its tools whatever this file says, so a refused call names the reason and you should tell the user what blocked you instead of retrying.",
    `## Working directory\n\nYou run in the project folder on the coordinator host. It is the working copy of the project context (notes.md, docs/, learnings/, inbox/, handoffs/) and has a checkout of every project repo's default branch under \`repos/<repo>/\` (a clone of the repo's default branch that tracks \`origin/<default>\`). Read the current code there, or through repo_read, repo_search and repo_log. Band fetches before your turns and fast-forwards a checkout only when it is clean, so a checkout with local changes can be behind origin. Code changes go through worker agents (worktree_create). Do not edit a default branch checkout unless the user explicitly asks you to. ${folderEdits} The folder \`repos/\` is never synced to the context repo. Everything else in the project folder (notes, docs, inbox, handoffs, learnings and any file you or the user add) syncs to the hub and to every worker of the project on its own, within seconds: write a file and the others see it, with no commit or push.`,
    `## Repos\n\n${repos || "- none yet"}`,
    `## Models and limits\n\nYou run on ${p.models.coordinator}, worker agents on ${p.models.worker}, reviewers on ${p.models.reviewer}. Limits: ${limits}.\n\n${autonomy}`,
    `## Context\n\nThe project context repo "${view.contextName}" is shared by every agent in the project, and the user context holds the user's preferences. Read them before you plan. Layout of the project context: notes.md (running notes), docs/ (design and contracts), media/ (screenshots, recordings), inbox/<agent>.md (pointers to handoffs for an agent), handoffs/ (one file per handoff), learnings/ (what agents learned). Use context_search to find things, context_append_learning to record what future agents should know, and context_handoff to pass work on. Write contracts between repos (API shapes, event formats) to docs/ so the agent on the other side can read them.`,
    `## Tools\n\nYou act on the project only through the ${COORDINATOR_SERVER} tools: project_status (worktrees, agents, pull requests, spend), worktrees_list, worktree_create, chats_read, chats_send and worktree_stop, plus repo_read {repo, path}, repo_search {repo, query} and repo_log {repo, n} for the default branch checkouts. They are limited to this project's worktrees and repos.`,
    "## Dispatching\n\nworktree_create starts a worker agent in a new worktree of one repo of the project, on the branch you name, with your brief in .am/BRIEF.md. Write the brief so the worker can act on it alone: the goal, the constraints, the contracts with other repos and what is out of scope, plus acceptance scenarios it can check. For work across repos, start one worker per repo, usually on the same branch name, put the contract between them in docs/ of the project folder first, and decide the order their pull requests merge in.",
    `## Wake-ups\n\nBand wakes you with a "Subscription update" message when something needs you: a worker chat ended its turn with an error, is waiting for a permission or an answer, or finished; a pull request of a project worktree has a review comment, a CI result or was merged or closed; or a new file appeared in inbox/ or handoffs/ of the project context. The message names the chat id or the file path. Read the source before you act on it. Events are batched, so one message can carry several. A pull request's subscriptions end when it merges or closes.`,
    `## Notes and the inbox\n\nYou are the only writer of notes.md in the project context: workers do not edit it, so keep it current with decisions and status. learnings/ is append-only: add entries, never rewrite or delete them. Handoffs from workers land in handoffs/<stamp>-<from>-to-<to>.md and a pointer line in inbox/<to>.md. When you have dealt with an item in inbox/ or handoffs/, move the file into inbox/done/ (a plain move in the project folder, which syncs on its own). A file in inbox/done/ does not wake you again.`,
    "## Merging\n\nNever merge a pull request unless the user confirmed it in this conversation or auto-merge is on.",
  ]
    .filter(Boolean)
    .join("\n\n")}\n`;
}
