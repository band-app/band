/**
 * The texts a dispatched worker agent starts from (plan step 6.3): the prompt that points it at
 * `.am/BRIEF.md`, and the brief file itself. Pure functions, so the wording lives in one place.
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
  "- Implement what {{briefPath}} scopes and nothing outside it.",
  "- Never run the app, the dev server or any test against real user data. Use a temporary data directory.",
  "- If a scenario turns out impossible or wrong, stop and say so rather than changing it.",
  "- Do not stop to check in. Ask only if you are blocked.",
  "- When implementation is done, check each acceptance scenario in the brief against the real system and report which pass, with evidence.",
].join("\n");

export function workerPrompt(template: string = WORKER_PROMPT_TEMPLATE): string {
  return template.replaceAll("{{briefPath}}", BRIEF_PATH);
}

export interface BriefSibling {
  repo: string;
  /** The sibling's worktree id. Its path depends on the host, which may not be placed yet. */
  worktreeId: string;
  role?: string | null;
}

export interface BriefInput {
  title?: string;
  branch: string;
  repo: string;
  /** The brief the coordinator wrote. */
  brief: string;
  scenarios: string[];
  /** Set for a member of a group. */
  group?: {
    id: string;
    mode: "split" | "combined";
    /** Repos in the order their pull requests merge. */
    mergeOrder: string[];
    siblings: BriefSibling[];
  };
}

export function renderBrief(input: BriefInput): string {
  const parts: string[] = [];
  parts.push(`## Task${input.title ? `: ${input.title}` : ""}`);
  parts.push(`Repo: ${input.repo}\nBranch: ${input.branch}`);
  parts.push(input.brief.trim());
  if (input.scenarios.length > 0) {
    parts.push(
      `## Acceptance scenarios\n${input.scenarios.map((s, i) => `- S${i + 1}: ${s.trim()}`).join("\n")}`,
    );
  }
  if (input.group) {
    const { group } = input;
    const lines = [
      `## Sibling worktrees`,
      `This task spans ${group.siblings.length + 1} repos and is split into one worktree and agent per repo, all on branch \`${input.branch}\`. You work only in ${input.repo}.`,
    ];
    if (group.siblings.length > 0) {
      lines.push(
        "Siblings:",
        ...group.siblings.map(
          (s) => `- ${s.repo}${s.role ? ` (${s.role})` : ""}: worktree \`${s.worktreeId}\``,
        ),
      );
    }
    lines.push(
      `Pull request order: ${group.mergeOrder.map((r, i) => `${i + 1}. ${r}`).join(", ")}. Open yours so it can merge in that order, and do not merge before the repos ahead of yours.`,
      "Write contracts shared with a sibling (API shapes, event formats) to the project context's docs/ so the other side can read them.",
    );
    parts.push(lines.join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}
