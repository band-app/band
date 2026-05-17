import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { AnchorHTMLAttributes } from "react";
import { openExternalUrl } from "../lib/open-external-url";

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

/**
 * Shared Streamdown plugin set used by both the chat message renderer and the
 * markdown file preview. Single source of truth so a config change (e.g.
 * enabling single-dollar inline math) lands in one place instead of drifting
 * across call sites.
 *
 * `singleDollarTextMath: true` opts into `remark-math`'s `$…$` inline syntax.
 * The closing `$` must be followed by whitespace or punctuation, so prose
 * containing literal dollar amounts like "\$5" still renders correctly.
 */
export const streamdownPlugins = {
  cjk,
  code,
  math: createMathPlugin({ singleDollarTextMath: true }),
  mermaid,
};
