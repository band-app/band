/**
 * Converts arbitrary text to a valid git branch name.
 * Keeps case and the ref characters git allows (`_`, `.`, `/`, `-`), turns whitespace
 * into hyphens and removes what `git check-ref-format` forbids.
 */
export function slugifyBranchName(input: string): string {
  let name = input
    .trim()
    .replace(/\s+/g, "-") // whitespace → hyphens
    // biome-ignore lint/suspicious/noControlCharactersInRegex: git forbids control characters in refs
    .replace(/[\x00-\x1f\x7f~^:?*[\\]/g, "") // characters git forbids
    .replace(/@\{/g, "") // reflog syntax
    .replace(/^@$/, "");
  // Removing characters can join two dots or braces, so repeat until stable.
  let previous: string;
  do {
    previous = name;
    name = name
      .replace(/\.{2,}/g, ".") // no ".."
      .replace(/@\{/g, "")
      .replace(/-{2,}/g, "-") // collapse runs of hyphens
      .replace(/\/+/g, "/") // collapse duplicate slashes
      .replace(/\/\./g, "/") // no component starting with "."
      .replace(/\.lock(?=\/|$)/g, "") // no component ending in ".lock"
      .replace(/\.+(?=\/|$)/g, "") // no component ending in "."
      .replace(/^[-/.]+|[-/.]+$/g, ""); // trim leading/trailing hyphens, slashes and dots
  } while (name !== previous);
  return name;
}
