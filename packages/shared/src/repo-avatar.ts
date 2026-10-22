/** How many colours a repo's fallback avatar picks from. Web and mobile each define this many. */
export const REPO_AVATAR_COLOR_COUNT = 6;

/** The letter a repo's fallback avatar shows: the first letter or digit of its name, upper-cased. */
export function repoAvatarInitial(name: string): string {
  const match = name.match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : "?";
}

/** Which of the `REPO_AVATAR_COLOR_COUNT` colours a repo gets. A stable hash of the name, so a repo keeps its colour on every device. */
export function repoAvatarColorIndex(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash % REPO_AVATAR_COLOR_COUNT;
}
