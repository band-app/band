/**
 * YAML frontmatter source model for the markdown preview's key/value grid.
 *
 * Only top-level `key: value` lines become entries. Lines indented under a
 * key (nested maps, list items, block scalars) belong to the entry above and
 * make its value read-only in the grid; comments and blank lines are kept
 * as they are. Every edit rewrites only the lines of the entry it changes,
 * keeping the key's spacing and the value's quote style.
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
  /** The value spans lines (list, nested map, block scalar). */
  multiline: boolean;
}

export interface FrontmatterSource {
  /** The block's lines, `---` delimiters included. */
  lines: string[];
  entries: FrontmatterEntry[];
}

/** `key`, the colon, the spaces after it, and the raw value. */
const ENTRY_LINE = /^([^\s#:][^:]*?)(\s*:)( *)(.*)$/;
/** Keys the grid writes: the frontmatter scan only recognises these. */
const KEY = /^[\w-]+$/;
const BLOCK_SCALAR = /^[|>][-+]?\d*$/;

function unquote(raw: string): { value: string; quote: '"' | "'" | null } {
  if (raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')) {
    return { value: raw.slice(1, -1).replace(/\\(.)/g, "$1"), quote: '"' };
  }
  if (raw.length > 1 && raw.startsWith("'") && raw.endsWith("'")) {
    return { value: raw.slice(1, -1).replace(/''/g, "'"), quote: "'" };
  }
  return { value: raw, quote: null };
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
    const { value, quote } = unquote(raw);
    current = {
      line: i,
      end: i,
      key: m[1].trim(),
      value,
      quote,
      multiline: BLOCK_SCALAR.test(raw),
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
  const m = ENTRY_LINE.exec(fm.lines[entry.line]);
  if (!m) return null;
  return withLines(fm, entry.line, entry.line + 1, [`${key}${m[2]}${m[3]}${m[4]}`]);
}

/** Sets entry `index`'s value, keeping its quote style. Null for multi-line values. */
export function setValue(fm: FrontmatterSource, index: number, text: string): string | null {
  const entry = fm.entries[index];
  if (!entry || entry.multiline) return null;
  const m = ENTRY_LINE.exec(fm.lines[entry.line]);
  if (!m) return null;
  const encoded = encodeValue(text, entry.quote);
  const line = encoded ? `${m[1]}${m[2]}${m[3] || " "}${encoded}` : `${m[1]}${m[2]}`;
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

/** Removes entry `index` with its continuation lines. */
export function deleteEntry(fm: FrontmatterSource, index: number): string | null {
  const entry = fm.entries[index];
  if (!entry || fm.entries.length <= 1) return null;
  return withLines(fm, entry.line, entry.end + 1, []);
}
