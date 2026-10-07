/**
 * The texts a task's agent starts from (plan steps 6.3 and T.2): the prompt that points it at
 * `BRIEF.md` in the task folder, and the brief file itself. Pure functions, so the wording lives
 * in one place.
 */

/** The brief in a task folder. A worktree that predates tasks keeps `.am/BRIEF.md`. */
export const BRIEF_DIR = ".am";
export const BRIEF_FILE = "BRIEF.md";
export const BRIEF_PATH = `${BRIEF_DIR}/${BRIEF_FILE}`;

/**
 * The prompt a task agent gets. The brief is the source of truth, so the prompt only points at it
 * and states the working rules.
 */
export const WORKER_PROMPT_TEMPLATE = [
  "Your task is in {{briefPath}}, in your working directory (the task folder). Read it first; it is the source of truth for this task.",
  "",
  "Working rules:",
  "- Implement what {{briefPath}} scopes and nothing outside it.",
  "- Each repo of this task is a git worktree in its own folder here. cd into it to run its tests and tools, and read its CLAUDE.md or AGENTS.md first.",
  "- If you need another repo of the project, call task_add_repo. Remove one you no longer need with task_remove_repo, which refuses while it has commits or changes.",
  "- Never run the app, the dev server or any test against real user data. Use a temporary data directory.",
  "- If a scenario turns out impossible or wrong, stop and say so rather than changing it.",
  "- Do not stop to check in. Ask only if you are blocked.",
  "- When implementation is done, check each acceptance scenario in the brief against the real system and report which pass, with evidence.",
].join("\n");

export function workerPrompt(template: string = WORKER_PROMPT_TEMPLATE): string {
  return template.replaceAll("{{briefPath}}", BRIEF_FILE);
}

export interface BriefRepo {
  repo: string;
  role?: string | null;
}

export interface BriefInput {
  title?: string;
  name: string;
  branch: string;
  /** The brief the coordinator or the user wrote. */
  brief: string;
  scenarios: string[];
  /** The repos the task starts with, in the order their pull requests merge. */
  repos: BriefRepo[];
}

export function renderBrief(input: BriefInput): string {
  const parts: string[] = [];
  parts.push(`## Task${input.title ? `: ${input.title}` : ""}`);
  parts.push(`Task: ${input.name}\nBranch: ${input.branch}`);
  parts.push(
    input.repos.length > 0
      ? [
          "## Repos",
          ...input.repos.map((r) => `- ${r.repo}${r.role ? ` (${r.role})` : ""}`),
          input.repos.length > 1
            ? `Each is a git worktree on branch \`${input.branch}\` in a folder of its own here. Pull request order: ${input.repos.map((r, i) => `${i + 1}. ${r.repo}`).join(", ")}. Open yours so it can merge in that order, and do not merge before the repos ahead of yours.`
            : `It is a git worktree on branch \`${input.branch}\` in a folder of its own here.`,
        ].join("\n")
      : "## Repos\nNone yet. Read the brief, then call task_add_repo for each repo of the project you need.",
  );
  parts.push(input.brief.trim());
  if (input.scenarios.length > 0) {
    parts.push(
      `## Acceptance scenarios\n${input.scenarios.map((s, i) => `- S${i + 1}: ${s.trim()}`).join("\n")}`,
    );
  }
  return `${parts.join("\n\n")}\n`;
}
