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
