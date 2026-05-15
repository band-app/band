/**
 * Lightweight YAML-frontmatter handling for the markdown preview.
 *
 * Plan files and SKILL.md files commonly start with a `---`-delimited YAML
 * block (`name`, `description`, etc.). We don't want to render that block as
 * literal text in the preview pane — instead, we extract the key/value pairs
 * and render them as a markdown table at the top of the document so they
 * remain visible and scannable without the raw delimiters.
 *
 * The parser here is intentionally minimal — string-valued keys only — and
 * mirrors the one in `packages/coding-agent/src/skills.ts` so behaviour
 * stays consistent across the codebase. A full YAML parser is overkill
 * for the metadata blocks we actually see in practice.
 */

const FRONTMATTER_DELIMITER = "---";

export interface ParsedMarkdown {
  /**
   * Ordered list of [key, value] pairs. We deliberately preserve insertion
   * order (and allow callers to render them as such) — Record<> would lose
   * source ordering, which matters for human-authored frontmatter.
   */
  frontmatter: Array<[string, string]>;
  /** Markdown body with the frontmatter block stripped off the front. */
  body: string;
}

/**
 * Parse YAML frontmatter from the start of a markdown document.
 *
 * Returns an empty list and the original content unchanged when no
 * frontmatter is present, or when the frontmatter is unterminated (so the
 * raw content still renders rather than silently disappearing).
 */
export function parseFrontmatter(content: string): ParsedMarkdown {
  // Fast-path the common case: most files have no frontmatter and we don't
  // want to pay for an O(n) split on every render. The trim-based check
  // below still handles the (rare) `  ---  ` whitespace edge case.
  if (!content || !content.startsWith("---")) {
    return { frontmatter: [], body: content };
  }

  const lines = content.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    return { frontmatter: [], body: content };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_DELIMITER) {
      endIndex = i;
      break;
    }
  }
  // Unterminated frontmatter — fall back to rendering the document as-is
  // so the user can still see and fix the malformed block.
  if (endIndex === -1) {
    return { frontmatter: [], body: content };
  }

  const frontmatter: Array<[string, string]> = [];
  for (let i = 1; i < endIndex; i++) {
    const line = lines[i];
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    // `value.length > 1` so a single-character quote (e.g. `key: "`) isn't
    // silently collapsed to an empty string by `slice(1, -1)`.
    if (
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      frontmatter.push([key, value]);
    }
  }

  // Trim leading blank lines so the rendered table sits flush against
  // the first real markdown block rather than picking up a stray empty
  // paragraph between the frontmatter and the body.
  const body = lines
    .slice(endIndex + 1)
    .join("\n")
    .replace(/^\n+/, "");
  return { frontmatter, body };
}

/**
 * Escape a frontmatter value for inclusion in a markdown table cell.
 *
 * Pipes are the column separator, and newlines would break the row;
 * neither can appear literally inside a GFM table cell.
 */
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Build a GFM markdown table from frontmatter key/value pairs.
 *
 * Returns an empty string when there are no pairs so callers can blindly
 * concatenate the result without conditionals.
 */
export function frontmatterToMarkdownTable(frontmatter: Array<[string, string]>): string {
  if (frontmatter.length === 0) return "";
  const header = "| Key | Value |\n| --- | --- |";
  const rows = frontmatter
    .map(([key, value]) => `| ${escapeTableCell(key)} | ${escapeTableCell(value)} |`)
    .join("\n");
  return `${header}\n${rows}`;
}

/**
 * Convert markdown content with optional YAML frontmatter into markdown with
 * the frontmatter block replaced by a table at the top. When there is no
 * frontmatter, the original content is returned unchanged so we don't pay
 * the cost of a string rewrite for the common case.
 */
export function applyFrontmatterTable(content: string): string {
  const { frontmatter, body } = parseFrontmatter(content);
  if (frontmatter.length === 0) return content;
  const table = frontmatterToMarkdownTable(frontmatter);
  return body ? `${table}\n\n${body}` : table;
}
