/**
 * What the chat composer decides from its text, the same on the web and on the phone: which
 * `/command` or `@file` token is being typed, which commands match it, and which attachments
 * the hub accepts.
 */

export interface SlashCommandSkill {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface TriggerContext {
  /** Everything before the trigger character. */
  prefix: string;
  /** What follows the trigger character. */
  query: string;
}

/**
 * The token being typed after `trigger` (`/` or `@`). The trigger can sit at the start of the
 * text or after whitespace. Null when the token is over (a space follows it) or absent.
 */
export function getTriggerContext(inputValue: string, trigger: "/" | "@"): TriggerContext | null {
  for (let i = inputValue.length - 1; i >= 0; i--) {
    if (inputValue[i] === trigger && (i === 0 || /\s/.test(inputValue[i - 1] ?? ""))) {
      const after = inputValue.slice(i + 1);
      if (/\s/.test(after)) return null;
      return { prefix: inputValue.slice(0, i), query: after };
    }
  }
  return null;
}

export const getCommandContext = (inputValue: string) => getTriggerContext(inputValue, "/");
export const getMentionContext = (inputValue: string) => getTriggerContext(inputValue, "@");

/**
 * Commands matching the partial name, best first, ranked the way Claude Code's own picker ranks
 * them: an exact name, then names starting with the query (shortest first), then names
 * containing it, then descriptions containing it. Codex prefixes skills with `$`, so `/tdd`
 * still finds `$tdd`. Ties keep the agent's order.
 */
export function filterSkills(skills: SlashCommandSkill[], query: string): SlashCommandSkill[] {
  if (!query) return skills;
  const q = query.toLowerCase();
  const rank = (skill: SlashCommandSkill): [number, number] => {
    const name = skill.name.toLowerCase();
    const bare = name.replace(/^\$/, "");
    if (name === q || bare === q) return [0, 0];
    if (name.startsWith(q) || bare.startsWith(q)) return [1, bare.length];
    if (name.includes(q)) return [2, 0];
    // Two letters appear in half of all descriptions ("un" in "run"), so
    // descriptions only count once the query says something.
    if (q.length >= 3 && skill.description.toLowerCase().includes(q)) return [3, 0];
    return [-1, 0];
  };
  return skills
    .map((skill, index) => ({ skill, index, rank: rank(skill) }))
    .filter((m) => m.rank[0] >= 0)
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.index - b.index)
    .map((m) => m.skill);
}

/** Largest attachment the composer sends. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Media types the composer accepts, as the web's file input lists them. */
export const ACCEPTED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  "text/yaml",
  "application/x-yaml",
];

/** A file in the shape `POST /api/chats/:id/messages` takes. */
export function toWireFile(mediaType: string, base64: string, filename?: string) {
  return {
    mediaType,
    url: `data:${mediaType};base64,${base64}`,
    ...(filename ? { filename } : {}),
  };
}
