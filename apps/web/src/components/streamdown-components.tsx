import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { type AnchorHTMLAttributes, useMemo } from "react";
import { useIsDark } from "../dashboard/hooks/use-is-dark";
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

/**
 * Turns inline math back into plain text when its closing `$` is directly
 * followed by a digit. This is Pandoc's rule: `$100 a month and Ultra gets $200`
 * is two prices, not a formula, while `$x^2$` still renders. The offsets come
 * from the parser, so the original source (dollar signs included) is restored.
 */
function restoreCurrencyText(node: MdNode, source: string): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "inlineMath") {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start !== undefined && end !== undefined && /\d/.test(source[end] ?? "")) {
        children[i] = { type: "text", value: source.slice(start, end) };
      }
    } else {
      restoreCurrencyText(child, source);
    }
  }
}

const baseMath = createMathPlugin({ singleDollarTextMath: true });
const [baseRemarkMath, baseRemarkMathOptions] = baseMath.remarkPlugin as [
  (this: unknown, options: unknown) => void,
  unknown,
];

/**
 * remark-math registered as usual, plus a transformer that applies the currency
 * rule above. A message that is still streaming re-parses on every update, so a
 * trailing `$` flips to text as soon as the digit after it arrives.
 */
function remarkMathWithCurrency(this: unknown) {
  baseRemarkMath.call(this, baseRemarkMathOptions);
  return (tree: MdNode, file: { value?: unknown }) => {
    if (typeof file.value === "string") restoreCurrencyText(tree, file.value);
  };
}

/**
 * Shared Streamdown plugin set used by both the chat message renderer and the
 * markdown file preview. Single source of truth so a config change lands in one
 * place instead of drifting across call sites.
 *
 * `singleDollarTextMath: true` opts into `remark-math`'s `$…$` inline syntax.
 * `remark-math` only rejects a span when the character after the opening `$` or
 * before the closing `$` is whitespace, so `costs $5 and $10` would still parse
 * as math (`5 and `). `remarkMathWithCurrency` adds the Pandoc rule: a closing
 * `$` followed by a digit is not a closing `$`. Authors can still escape with `\$`.
 */
export const streamdownPlugins = {
  cjk,
  code: createCodePlugin({ themes: BAND_SHIKI_THEMES }),
  math: { ...baseMath, remarkPlugin: remarkMathWithCurrency },
  mermaid,
};

/**
 * Mermaid config for the current light/dark mode, for Streamdown's `mermaid`
 * prop. The object changes only when the mode flips, which makes open diagrams
 * re-render. Every Streamdown call site passes it, because `mermaid.initialize`
 * is global and a diagram rendered without it would reset the theme. Streamdown
 * does not redraw an open diagram when only the config changes, so call sites
 * also set `key={mermaid.config.theme}` to remount it.
 */
export function useStreamdownMermaid() {
  const isDark = useIsDark();
  return useMemo(() => ({ config: { theme: isDark ? "dark" : "default" } }) as const, [isDark]);
}
