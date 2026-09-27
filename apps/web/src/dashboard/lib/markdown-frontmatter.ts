/**
 * YAML frontmatter source model for the markdown preview's key/value grid.
 *
 * Only top-level `key: value` lines become entries. Lines indented under a
 * key (nested maps, list items, block scalars) belong to the entry above and
 * make its value read-only in the grid; comments and blank lines are kept
 * as they are. Every edit rewrites only the lines of the entry it changes,
 * keeping the key's spacing, the value's quote style and a trailing comment.
 * A double-quoted value with escapes other than `\\` and `\"` (`\n`,
 * `\t`, `\u…`) is read-only too, rather than decoded and re-encoded.
 */

export interface FrontmatterEntry {
  /** Index of the entry's `key:` line in the block's lines. */
  line: number;
  /** Index of the entry's last line, continuation lines included. */
  end: number;
  key: string;
  /** The value as shown: unquoted, or the continuation lines joined. */
  value: string;
  quote: '"' | "'" | null;
  /** A trailing ` # comment` after the value, leading space included. */
  comment: string;
  /** The value spans lines (list, nested map, block scalar). */
  multiline: boolean;
  /** The grid cannot write the value (multi-line, or escapes it would lose). */
  readOnly: boolean;
}

export interface FrontmatterSource {
  /** The block's lines, `---` delimiters included. */
  lines: string[];
  entries: FrontmatterEntry[];
}

/** `key`, the colon, the spaces after it, and the raw value. */
const ENTRY_LINE = /^([^\s#:][^:]*?)(\s*:)( *)(.*)$/;
/**
 * Keys the grid writes. The preview only treats a block as frontmatter when
 * its first entry's key looks like this (`findFrontmatter`).
 */
const KEY = /^[\w-]+$/;
const KEY_LINE = /^[\w-]+\s*:/;
const BLOCK_SCALAR = /^[|>][-+]?\d*$/;
const DOUBLE_QUOTED = /^("(?:[^"\\]|\\.)*")(\s+#.*)?$/;
const SINGLE_QUOTED = /^('(?:[^']|'')*')(\s+#.*)?$/;

interface ParsedValue {
  value: string;
  quote: '"' | "'" | null;
  comment: string;
  /** Escapes the grid would not round-trip. */
  escaped: boolean;
}

function parseValue(raw: string): ParsedValue {
  const double = DOUBLE_QUOTED.exec(raw);
  if (double) {
    const inner = double[1].slice(1, -1);
    const escaped = /\\[^\\"]/.test(inner);
    const value = escaped ? inner : inner.replace(/\\(["\\])/g, "$1");
    return { value, quote: '"', comment: double[2] ?? "", escaped };
  }
  const single = SINGLE_QUOTED.exec(raw);
  if (single) {
    const value = single[1].slice(1, -1).replace(/''/g, "'");
    return { value, quote: "'", comment: single[2] ?? "", escaped: false };
  }
  const hash = /\s#/.exec(raw);
  return hash
    ? {
        value: raw.slice(0, hash.index),
        quote: null,
        comment: raw.slice(hash.index),
        escaped: false,
      }
    : { value: raw, quote: null, comment: "", escaped: false };
}

export function parseFrontmatterBlock(source: string): FrontmatterSource {
  const lines = source.split("\n");
  const entries: FrontmatterEntry[] = [];
  let current: FrontmatterEntry | null = null;
  const continuation: string[] = [];
  const finish = () => {
    if (current?.multiline) {
      const list = continuation.every((l) => l.startsWith("-"));
      const parts = continuation.map((l) => (list ? l.replace(/^-\s*/, "") : l));
      const inline = current.value && !BLOCK_SCALAR.test(current.value) ? [current.value] : [];
      current.value = [...inline, ...parts].join(list ? ", " : " ");
    }
    continuation.length = 0;
  };
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^\s/.test(line) || line === "-" || line.startsWith("- ")) {
      if (current) {
        current.end = i;
        current.multiline = true;
        current.readOnly = true;
        continuation.push(trimmed);
      }
      continue;
    }
    finish();
    const m = ENTRY_LINE.exec(line);
    if (!m) {
      current = null;
      continue;
    }
    const raw = m[4].trim();
    const { value, quote, comment, escaped } = parseValue(raw);
    const blockScalar = BLOCK_SCALAR.test(value);
    current = {
      line: i,
      end: i,
      key: m[1].trim(),
      value,
      quote,
      comment,
      multiline: blockScalar,
      readOnly: blockScalar || escaped,
    };
    entries.push(current);
  }
  finish();
  return { lines, entries };
}

function needsQuotes(text: string): boolean {
  return text !== text.trim() || /^[-?:,[\]{}#&*!|>'"%@`]/.test(text) || /:\s|\s#|:$/.test(text);
}

function encodeValue(text: string, quote: '"' | "'" | null): string {
  if (!text) return "";
  if (quote === "'") return `'${text.replace(/'/g, "''")}'`;
  if (quote === '"' || needsQuotes(text)) {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return text;
}

function withLines(fm: FrontmatterSource, from: number, to: number, insert: string[]): string {
  return [...fm.lines.slice(0, from), ...insert, ...fm.lines.slice(to)].join("\n");
}

/**
 * Renames entry `index`. Returns null when `key` is not a plain key
 * (letters, digits, `_`, `-`); the document keeps the old key until it is.
 */
export function setKey(fm: FrontmatterSource, index: number, key: string): string | null {
  const entry = fm.entries[index];
  if (!entry || !KEY.test(key)) return null;
  // A second entry with the same key is not valid YAML.
  if (fm.entries.some((e, i) => i !== index && e.key === key)) return null;
  const m = ENTRY_LINE.exec(fm.lines[entry.line]);
  if (!m) return null;
  return withLines(fm, entry.line, entry.line + 1, [`${key}${m[2]}${m[3]}${m[4]}`]);
}

/**
 * Sets entry `index`'s value, keeping its quote style and trailing comment.
 * Null for a read-only value.
 */
export function setValue(fm: FrontmatterSource, index: number, text: string): string | null {
  const entry = fm.entries[index];
  if (!entry || entry.readOnly) return null;
  const m = ENTRY_LINE.exec(fm.lines[entry.line]);
  if (!m) return null;
  const encoded = encodeValue(text, entry.quote);
  const line = `${m[1]}${m[2]}${encoded ? `${m[3] || " "}${encoded}` : ""}${entry.comment}`;
  return withLines(fm, entry.line, entry.line + 1, [line]);
}

/** The first of `key`, `key-2`, `key-3`, ... that no entry uses. */
export function unusedKey(fm: FrontmatterSource): string {
  const keys = new Set(fm.entries.map((e) => e.key));
  let n = 1;
  while (keys.has(n === 1 ? "key" : `key-${n}`)) n++;
  return n === 1 ? "key" : `key-${n}`;
}

/** Inserts an empty entry so that it becomes entry `index`. */
export function insertEntry(fm: FrontmatterSource, index: number): string {
  const at = index < fm.entries.length ? fm.entries[index].line : fm.lines.length - 1;
  return withLines(fm, at, at, [`${unusedKey(fm)}:`]);
}

/**
 * Removes entry `index` with its continuation lines. Null for the last
 * entry, and when the block would no longer start with a key line (a comment
 * or blank line would move up to be its first line) and stop being read as
 * frontmatter.
 */
export function deleteEntry(fm: FrontmatterSource, index: number): string | null {
  const entry = fm.entries[index];
  if (!entry || fm.entries.length <= 1) return null;
  const next = withLines(fm, entry.line, entry.end + 1, []);
  return KEY_LINE.test(next.split("\n")[1] ?? "") ? next : null;
}
