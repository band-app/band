/**
 * The texts a coordinator's worker agent starts from: the prompt that points it at `.am/BRIEF.md`
 * in its worktree, and the brief file itself. Pure functions, so the wording lives in one place.
 */

/** Where the brief goes in a worktree. `.am/` is excluded from git. */
export const BRIEF_DIR = ".am";
export const BRIEF_FILE = "BRIEF.md";
export const BRIEF_PATH = `${BRIEF_DIR}/${BRIEF_FILE}`;

/**
 * The prompt a worker gets. The brief is the source of truth, so the prompt only points at it
 * and states the working rules. `{{briefPath}}` is replaced when the prompt is built.
 */
export const WORKER_PROMPT_TEMPLATE = [
  "Your task is in {{briefPath}}. Read it first; it is the source of truth for this task.",
  "",
  "Working rules:",
  "- Implement what {{briefPath}} scopes and nothing outside it. You work in this one repo only.",
  "- The project's shared files (notes.md, docs/, inbox/, handoffs/, learnings/) are in the project folder your instructions name. They sync to every agent of the project on their own: write a file there and the others see it, with no commit or push. Put contracts another repo's agent needs (API shapes, event formats) in its docs/.",
  "- Never run the app, the dev server or any test against real user data. Use a temporary data directory.",
  "- If a scenario turns out impossible or wrong, stop and say so rather than changing it.",
  "- Do not stop to check in. Ask only if you are blocked.",
  "- When implementation is done, check each acceptance scenario in the brief against the real system and report which pass, with evidence.",
].join("\n");

export function workerPrompt(template: string = WORKER_PROMPT_TEMPLATE): string {
  return template.replaceAll("{{briefPath}}", BRIEF_PATH);
}

export interface BriefInput {
  title?: string;
  project: string;
  repo: string;
  branch: string;
  /** The brief the coordinator wrote. */
  brief: string;
  scenarios: string[];
}

export function renderBrief(input: BriefInput): string {
  const parts: string[] = [];
  parts.push(`## Task${input.title ? `: ${input.title}` : ""}`);
  parts.push(`Project: ${input.project}\nRepo: ${input.repo}\nBranch: ${input.branch}`);
  parts.push(input.brief.trim());
  if (input.scenarios.length > 0) {
    parts.push(
      `## Acceptance scenarios\n${input.scenarios.map((s, i) => `- S${i + 1}: ${s.trim()}`).join("\n")}`,
    );
  }
  return `${parts.join("\n\n")}\n`;
}
