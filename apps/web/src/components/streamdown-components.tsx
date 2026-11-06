import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { AnchorHTMLAttributes } from "react";
import { openExternalUrl } from "../lib/open-external-url";
import { BAND_SHIKI_THEMES } from "./shiki-band-theme";

/**
 * Custom `<a>` element for Streamdown that opens external links in the system
 * browser rather than navigating the desktop webview.
 *
 * Pass this via the Streamdown `components` prop:
 *
 *   <Streamdown components={streamdownComponents} ... />
 */
function ExternalLink({
  href,
  children,
  node: _node,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (href) {
      e.preventDefault();
      openExternalUrl(href);
    }
  };

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} {...props}>
      {children}
    </a>
  );
}

/** Shared Streamdown component overrides. */
export const streamdownComponents = { a: ExternalLink };

/** Minimal mdast shape the currency filter reads and rewrites. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const WORD_CHAR = /[A-Za-z0-9]/;

/**
 * Whether an `inlineMath` node (`$…$`, parsed by remark-math) is really prose.
 * `source` is the whole document and `start`/`end` the node's offsets in it.
 * `$$…$$` is always math. For `$…$` the text is prose when any of these holds:
 *
 * - the closing `$` is directly followed by a digit (Pandoc's rule: `$5 and $10`);
 * - the opening `$` follows a digit, with or without spaces between (`10 $ … 19,80 $`,
 *   the suffix currency style of most European languages), or follows a letter
 *   (`US$10`, `a$b$c`);
 * - the content starts or ends with whitespace (`$ 10`, `$HOME and $PATH`);
 * - the content is an upper-case word of two or more characters, as in `$HOME` or
 *   `$PATH/$HOME`, or ends with `/`.
 */
function isProseDollar(source: string, start: number, end: number): boolean {
  const raw = source.slice(start, end);
  if (raw.startsWith("$$")) return false;
  if (/\d/.test(source[end] ?? "")) return true;
  if (/\d\s*$/.test(source.slice(Math.max(0, start - 16), start))) return true;
  if (WORD_CHAR.test(source[start - 1] ?? "")) return true;
  const content = raw.slice(1, -1);
  if (/^\s|\s$/.test(content)) return true;
  return /^[A-Z_][A-Z0-9_]+$/.test(content) || content.endsWith("/");
}

/**
 * Turns inline math back into plain text when `isProseDollar` says it is prose, so
 * `$x^2$` still renders while money, shell variables and paths read as written.
 * The offsets come from the parser, so the original source is restored (an escaped
 * `\$` loses its backslash, as it would outside a formula).
 */
function restoreProseDollars(node: MdNode, source: string): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "inlineMath") {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start !== undefined && end !== undefined && isProseDollar(source, start, end)) {
        children[i] = { type: "text", value: source.slice(start, end).replaceAll("\\$", "$") };
      }
    } else {
      restoreProseDollars(child, source);
    }
  }
}

/** HTML elements the chat may render. Any other `<name>` in prose is literal text. */
const HTML_TAGS = new Set(
  (
    "a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del " +
    "details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd " +
    "li main mark nav ol p picture pre q rp rt ruby s samp section small source span strong sub " +
    "summary sup table tbody td tfoot th thead time tr u ul var video wbr"
  ).split(" "),
);

/**
 * Turns an inline HTML node whose tag is not a real HTML element (`<repo>-<branch>`,
 * `Array<string>`) into text. Left alone, the sanitizer drops the tag and its name
 * disappears from the message. Comments and real tags such as `<kbd>` pass through.
 */
function restoreUnknownTags(node: MdNode): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "html" && node.type !== "root") {
      const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)[\s/>]/.exec(child.value ?? "")?.[1];
      if (name && !HTML_TAGS.has(name.toLowerCase())) {
        children[i] = { type: "text", value: child.value };
      }
    } else {
      restoreUnknownTags(child);
    }
  }
}

const baseMath = createMathPlugin({ singleDollarTextMath: true });
const [baseRemarkMath, baseRemarkMathOptions] = baseMath.remarkPlugin as [
  (this: unknown, options: unknown) => void,
  unknown,
];

/**
 * remark-math registered as usual, plus a transformer that applies the prose
 * rules above (dollar signs, unknown tags). A message that is still streaming
 * re-parses on every update, so a trailing `$` flips to text as soon as the digit
 * after it arrives.
 */
function remarkMathWithCurrency(this: unknown) {
  baseRemarkMath.call(this, baseRemarkMathOptions);
  return (tree: MdNode, file: { value?: unknown }) => {
    if (typeof file.value === "string") restoreProseDollars(tree, file.value);
    restoreUnknownTags(tree);
  };
}

/**
 * Shared Streamdown plugin set used by both the chat message renderer and the
 * markdown file preview. Single source of truth so a config change lands in one
 * place instead of drifting across call sites.
 *
 * `singleDollarTextMath: true` opts into `remark-math`'s `$…$` inline syntax.
 * `remark-math` accepts almost any `$…$` span, so `costs $5 and $10`, `10 $ … 19 $`
 * and `$HOME and $PATH` would parse as math. `remarkMathWithCurrency` turns those
 * back into text (see `isProseDollar`). Authors can still escape with `\$`.
 */
export const streamdownPlugins = {
  cjk,
  code: createCodePlugin({ themes: BAND_SHIKI_THEMES }),
  math: { ...baseMath, remarkPlugin: remarkMathWithCurrency },
  mermaid,
};
