/** The prompt of a retro run (plan step 6.5), built from what the hub read out of the project's context. */

export interface RetroFile {
  path: string;
  content: string;
}

export interface RetroPromptInput {
  project: string;
  repos: string[];
  notes: RetroFile | null;
  learnings: RetroFile[];
  handoffs: RetroFile[];
  groups: Array<{ title: string; branch: string; members: Array<{ repo: string; pr: string }> }>;
  /** Files of the user context an edit may target, with their content. */
  userFiles: RetroFile[];
  userContext: boolean;
}

const FILE_CHARS = 6_000;
const TOTAL_CHARS = 90_000;

function clip(text: string): string {
  return text.length > FILE_CHARS
    ? `${text.slice(0, FILE_CHARS)}\n[cut: ${text.length - FILE_CHARS} more characters]`
    : text;
}

export function renderRetroPrompt(input: RetroPromptInput): string {
  let budget = TOTAL_CHARS;
  // Files the agent must rewrite whole are never clipped, or it would rewrite from a cut copy.
  const files = (heading: string, list: RetroFile[], whole = false): string => {
    const parts: string[] = [];
    for (const f of list) {
      const body = whole ? f.content : clip(f.content);
      if (body.length > budget) {
        parts.push(`(${list.length - parts.length} more files left out to keep this prompt short)`);
        break;
      }
      budget -= body.length;
      parts.push(`### ${f.path}\n\n${body}`);
    }
    return parts.length ? `## ${heading}\n\n${parts.join("\n\n")}` : `## ${heading}\n\nNone.`;
  };
  const groups = input.groups.length
    ? input.groups
        .map(
          (g) =>
            `- ${g.title} (branch ${g.branch}): ${g.members.map((m) => `${m.repo} ${m.pr}`).join(", ")}`,
        )
        .join("\n")
    : "None.";
  return [
    `Retro for the Band project "${input.project}". Repos: ${input.repos.join(", ") || "none"}.`,
    "Read what the project learned since the last retro and propose edits. Nothing you propose is applied until the user accepts it item by item.",
    files("Current notes.md", input.notes ? [input.notes] : [], true),
    files("Recent learnings (newest first)", input.learnings),
    files("Recent handoffs (newest first)", input.handoffs),
    `## Task groups\n\n${groups}`,
    input.userContext
      ? files("Skills and preferences in the user context", input.userFiles, true)
      : "## User context\n\nNone.",
    [
      "## What to propose",
      "- A merged, shorter notes.md: fold the learnings and handoffs that still matter into it, drop what is stale or finished. Propose it as one item with target project-context, path notes.md and the complete new content.",
      "- Archive learnings that are old, already folded into notes.md or no longer true: one item per file with target project-context, path learnings/<file> and moveTo learnings/archive/<file>.",
      "- Changes to skills or CLAUDE.md that would have prevented a repeated mistake. A skill in the user context is target user-context with the complete new content. A change in one of the project's repos is target repo with repo, path and a change a worker agent can apply in a pull request.",
      "- Give every item a rationale that names the evidence (a learning, a handoff, a task group).",
      "- Never include credentials, tokens or private keys in any content.",
      "- Propose nothing you cannot justify from the material above. An empty list is a valid answer.",
      "",
      "Call retro_propose exactly once, with all items, then stop. Do not edit any file yourself.",
    ].join("\n"),
  ].join("\n\n");
}

export function retroCharter(project: string): string {
  return [
    `You are the retro agent of the Band project "${project}". You run on a schedule, read the project's recent learnings, handoffs and finished task groups, and propose edits to its notes and skills.`,
    "You only propose. You never write to the project context or a repo yourself, and you never change a file in your working directory. Your one tool is retro_propose on the band-retro server. The user reviews each item and accepts or rejects it.",
    "notes.md belongs to the project's coordinator. Propose edits to it as complete replacement content, shorter than before, with decisions and current status kept and finished work dropped. learnings/ is append-only for everyone else, so an old learning is archived, never rewritten.",
  ].join("\n\n");
}
