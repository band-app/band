/**
 * Markdown as a small block tree the chat renders with native views. `marked`'s lexer does the
 * parsing (GFM tables, task lists, strikethrough and autolinks, with a single newline as a line
 * break like the web chat's `remark-breaks`); this module only reshapes its tokens.
 *
 * Fences the web draws (mermaid diagrams, `$$` math) stay code blocks here, with a label.
 * File paths become file links the same way the web chat finds them: inline code that
 * `isFilePath` accepts, and plain-text paths with a line number.
 *
 * Pure and dependency-light, so the chat can re-parse the streaming message on every chunk.
 */

import { findFilePaths, isFilePath } from "@band-app/client/file-path-detection";
import { Marked, type Token, type TokenizerExtension, type Tokens } from "marked";

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  /** A web link, or a file path in the worktree. */
  link?: { url: string } | { file: string };
}

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  /** `true` or `false` for a task list item, absent otherwise. */
  checked?: boolean;
  blocks: Block[];
}

export type Block =
  | { type: "heading"; depth: number; spans: Span[] }
  | { type: "paragraph"; spans: Span[] }
  | {
      type: "code";
      lang: string;
      text: string;
      label?: "diagram" | "math";
      /** A fence still streaming: no closing marker yet. */
      open?: boolean;
    }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "quote"; blocks: Block[] }
  | { type: "table"; align: Align[]; header: Span[][]; rows: Span[][][] }
  | { type: "rule" };

/** `$$ ... $$` as its own block; shown as code until the app renders math. */
const blockMath: TokenizerExtension = {
  name: "math",
  level: "block",
  start: (src) => src.match(/^\$\$/m)?.index,
  tokenizer(src) {
    const match = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src);
    if (match) return { type: "math", raw: match[0], text: match[1].trim() };
    return undefined;
  },
};

/** `$$x$$` inside a line, shown as inline code. A single `$` stays text, as on the web. */
const inlineMath: TokenizerExtension = {
  name: "inlineMath",
  level: "inline",
  start: (src) => src.indexOf("$$"),
  tokenizer(src) {
    const match = /^\$\$([^$\n]+?)\$\$/.exec(src);
    if (match) return { type: "codespan", raw: match[0], text: match[1].trim() };
    return undefined;
  },
};

/** The closing line of a fenced block (an opening line alone is not one). */
const CLOSING_FENCE = /\n {0,3}(`{3,}|~{3,})[^\S\n]*\n*$/;

// The math extensions' `start` hooks rescan the rest of the source for every token, so text
// without `$$` is lexed without them.
const marked = new Marked({ gfm: true, breaks: true });
const markedWithMath = new Marked({ gfm: true, breaks: true, extensions: [blockMath, inlineMath] });

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Marked keeps character references in text tokens; the HTML renderer would resolve them. */
function decode(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

type Style = Omit<Span, "text">;

/** Plain text, with paths like `src/app.ts:12` split out as file links. */
function textSpans(text: string, style: Style): Span[] {
  if (style.link) return [{ text, ...style }];
  const spans: Span[] = [];
  let at = 0;
  for (const match of findFilePaths(text)) {
    if (match.start > at) spans.push({ text: text.slice(at, match.start), ...style });
    spans.push({ text: match.path, ...style, link: { file: match.path } });
    at = match.end;
  }
  if (at < text.length) spans.push({ text: text.slice(at), ...style });
  return spans;
}

/** Schemes a tap may open. Any other (`band:`, `tel:`, another app's deep link) stays text. */
const OPENABLE_SCHEME = /^(https?|mailto):/i;

function linkTarget(href: string): Span["link"] {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href))
    return OPENABLE_SCHEME.test(href) ? { url: href } : undefined;
  if (isFilePath(href)) return { file: href };
  // `#section`, `/api/x`: nothing a tap could open.
  return undefined;
}

function inline(tokens: Token[] | undefined, style: Style = {}): Span[] {
  const spans: Span[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
        if (token.tokens?.length) spans.push(...inline(token.tokens, style));
        else spans.push(...textSpans(decode(token.text), style));
        break;
      case "escape":
        spans.push({ text: token.text, ...style });
        break;
      case "strong":
        spans.push(...inline(token.tokens, { ...style, bold: true }));
        break;
      case "em":
        spans.push(...inline(token.tokens, { ...style, italic: true }));
        break;
      case "del":
        spans.push(...inline(token.tokens, { ...style, strike: true }));
        break;
      case "codespan": {
        const text = decode(token.text);
        const file = !style.link && isFilePath(text) ? { file: text.trim() } : undefined;
        spans.push({ text, ...style, code: true, ...(file && { link: file }) });
        break;
      }
      case "br":
        spans.push({ text: "\n", ...style });
        break;
      case "link": {
        const link = linkTarget(token.href);
        spans.push(...inline(token.tokens, link ? { ...style, link } : style));
        break;
      }
      case "image": {
        // A picture in an agent's prose is rare; the chat shows its alt text as a link.
        const link = linkTarget(token.href);
        spans.push({ text: token.text || token.href, ...style, ...(link && { link }) });
        break;
      }
      case "html":
        spans.push({ text: token.text, ...style });
        break;
      default:
        if ("text" in token && typeof token.text === "string") {
          spans.push({ text: decode(token.text), ...style });
        }
    }
  }
  return spans;
}

function blocks(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        out.push({ type: "heading", depth: token.depth, spans: inline(token.tokens) });
        break;
      case "paragraph":
        out.push({ type: "paragraph", spans: inline(token.tokens) });
        break;
      case "text":
        // A tight list item's text.
        out.push({
          type: "paragraph",
          spans: token.tokens?.length ? inline(token.tokens) : textSpans(decode(token.text), {}),
        });
        break;
      case "code": {
        const lang = (token.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
        out.push({
          type: "code",
          lang,
          text: token.text,
          ...(lang === "mermaid" && { label: "diagram" as const }),
          ...((lang === "math" || lang === "latex") && { label: "math" as const }),
          ...(token.codeBlockStyle !== "indented" &&
            !CLOSING_FENCE.test(token.raw) && { open: true }),
        });
        break;
      }
      case "math":
        out.push({ type: "code", lang: "latex", text: token.text, label: "math" });
        break;
      case "list":
        out.push({
          type: "list",
          ordered: token.ordered,
          start: typeof token.start === "number" ? token.start : 1,
          items: (token as Tokens.List).items.map((item) => ({
            ...(item.task && { checked: item.checked ?? false }),
            blocks: blocks(item.tokens.filter((t) => t.type !== "checkbox")),
          })),
        });
        break;
      case "blockquote":
        out.push({ type: "quote", blocks: blocks((token as Tokens.Blockquote).tokens) });
        break;
      case "table": {
        const table = token as Tokens.Table;
        out.push({
          type: "table",
          align: table.align,
          header: table.header.map((cell) => inline(cell.tokens)),
          rows: table.rows.map((row) => row.map((cell) => inline(cell.tokens))),
        });
        break;
      }
      case "hr":
        out.push({ type: "rule" });
        break;
      case "html":
        if (token.text.trim())
          out.push({ type: "paragraph", spans: [{ text: token.text.trim() }] });
        break;
      default:
        break;
    }
  }
  return out;
}

export function parseMarkdown(source: string): Block[] {
  return blocks((source.includes("$$") ? markedWithMath : marked).lexer(source));
}

/** The text of spans, for accessibility labels and copying. */
export function spansText(spans: readonly Span[]): string {
  return spans.map((s) => s.text).join("");
}
