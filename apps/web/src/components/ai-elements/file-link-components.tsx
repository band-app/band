import { cn } from "@band-app/ui";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useCallback, useContext } from "react";
import {
  type Components,
  defaultUrlTransform,
  type ExtraProps,
  type UrlTransform,
} from "streamdown";

import { isFilePath } from "../../lib/file-path-detection";
import { openExternalUrl } from "../../lib/open-external-url";

// Re-exported so existing importers of `isFilePath` from this module keep
// working; the canonical home is now the shared, React-free detection module.
export { isFilePath };

// ---------------------------------------------------------------------------
// Workspace context — scopes `band:open-file` dispatches to the workspace
// that owns the chat dispatching the click.
//
// Multiple workspaces can be alive at once (the per-panel content cache in
// MultiWorkspacePanelHost keeps up to `maxCachedWorkspaces` workspace
// subtrees mounted), and `dispatchOpenFile` is a window-scoped CustomEvent.
// Without a workspace label on the event, every mounted layout's listener
// races to open the file against its OWN active workspace — and the
// `SharedDockviewLayout` listener (the only one for the desktop dockview)
// is bound to whichever workspace is currently focused, not the one whose
// chat actually fired the click. The result is a cross-workspace leak:
// click a `band-file:` link in workspace A's chat while workspace B is the
// active tab → the file opens in B (and is persisted into B's
// `band-open-tabs:` localStorage entry), often as a bogus path that
// doesn't resolve on disk. See issue #539.
//
// The fix is to attach the chat pane's workspace id to every dispatched
// event and to filter on it in every listener (same shape every other
// cross-workspace window event in this codebase already uses — see the
// `band:open-file-external`, `band:format-current-file`, and
// `band:open-language-picker` listeners). The context exists because
// `FileLinkedAnchor` is wired in as a static `Components` map for
// Streamdown, so the workspace id can't be passed in via props; ChatView
// wraps its message render in `<FileLinkWorkspaceProvider>` and the
// anchor reads from there at click time.
// ---------------------------------------------------------------------------

const FileLinkWorkspaceContext = createContext<string | undefined>(undefined);

/**
 * Wrap a subtree (typically the chat message list) so any
 * `band-file:` link clicked inside dispatches an event scoped to this
 * workspace. Without this provider the dispatched event carries no
 * workspaceId and every mounted workspace's listener will race for it.
 */
export function FileLinkWorkspaceProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}): ReactNode {
  // `workspaceId` is a string primitive — `Object.is` (which Context.Provider
  // uses to decide whether consumers re-render) already short-circuits on
  // value equality, so no `useMemo` is needed to stabilise identity. The
  // Provider re-renders whenever the *value* changes; identical strings
  // across renders are a no-op for consumers.
  return (
    <FileLinkWorkspaceContext.Provider value={workspaceId}>
      {children}
    </FileLinkWorkspaceContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Custom event dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a workspace-scoped `band:open-file` event.
 *
 * `workspaceId` is read from `FileLinkWorkspaceContext` at click time and
 * MUST be supplied — when undefined (a `FileLinkedAnchor` rendered outside
 * a `FileLinkWorkspaceProvider`) we still dispatch, but the event detail's
 * `workspaceId` is `undefined`. Listeners treat the missing-workspace
 * case as "fall through to the active workspace" so existing call sites
 * outside chat (none today, but a forward-compat hatch) keep working.
 */
function dispatchOpenFile(filename: string, workspaceId: string | undefined) {
  window.dispatchEvent(new CustomEvent("band:open-file", { detail: { filename, workspaceId } }));
}

// ---------------------------------------------------------------------------
// Rehype plugin — wrap inline code file paths in <a> links
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: unified/hast plugin operates on untyped AST nodes
type HastNode = any;

/**
 * Recursively extract plain text content from a hast node's children.
 * Handles both simple text children and nested elements (e.g. Shiki
 * spans from syntax-highlighted inline code).
 */
function extractHastText(node: HastNode): string | null {
  if (!Array.isArray(node.children)) return null;
  let text = "";
  for (const child of node.children) {
    if (child.type === "text") {
      text += child.value;
    } else if (child.type === "element" && Array.isArray(child.children)) {
      const childText = extractHastText(child);
      if (childText === null) return null;
      text += childText;
    } else {
      return null;
    }
  }
  return text;
}

/**
 * Rehype plugin that finds inline `<code>` elements (not inside `<pre>`)
 * whose text matches a file path pattern, and wraps them in an `<a>` tag
 * with `href="band-file:..."`.
 *
 * This avoids overriding the `code` component, so the @streamdown/code
 * Shiki plugin continues to render fenced code blocks normally.
 */
function rehypeFileLinkedCode() {
  return (tree: HastNode) => {
    walkHast(tree);
  };

  function walkHast(node: HastNode) {
    // Process both root and element nodes
    if ((node.type !== "element" && node.type !== "root") || !Array.isArray(node.children)) {
      return;
    }

    // Process children (iterate over a copy since we may mutate)
    const children = [...node.children];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type !== "element") continue;

      // Skip <pre> children entirely (fenced code blocks)
      if (child.tagName === "pre") continue;

      if (child.tagName === "code" && node.tagName !== "pre") {
        // This is an inline <code> element
        const text = extractHastText(child);
        if (text && isFilePath(text)) {
          // Wrap the <code> in an <a href="band-file:..."> element
          const link: HastNode = {
            type: "element",
            tagName: "a",
            properties: { href: `band-file:${text.trim()}` },
            children: [child],
          };
          // Replace the child in the parent's children array
          node.children[i] = link;
        }
      } else {
        // Recurse into other elements
        walkHast(child);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Streamdown component overrides
// ---------------------------------------------------------------------------

/**
 * Streamdown `a` component override.
 *
 * Intercepts links with the `band-file:` protocol (generated by the
 * remarkFileLinks and rehypeFileLinkedCode plugins) and dispatches an
 * open-file event instead of navigating. All other links render normally.
 */
function FileLinkedAnchor(props: ComponentProps<"a"> & ExtraProps) {
  const { node: _node, href, children, ...rest } = props;

  const isBandFile = typeof href === "string" && href.startsWith("band-file:");
  // Workspace id is read at click time so that a `MessageResponse` rendered
  // inside two workspaces (LRU cache) routes each click to the workspace
  // that *owns* the surrounding subtree — not whichever workspace happens
  // to be active when the listener fires.
  const workspaceId = useContext(FileLinkWorkspaceContext);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (href) {
        e.preventDefault();
        e.stopPropagation();
        if (isBandFile) {
          dispatchOpenFile(href.slice("band-file:".length), workspaceId);
        } else {
          openExternalUrl(href);
        }
      }
    },
    [isBandFile, href, workspaceId],
  );

  if (isBandFile) {
    return (
      <a
        {...rest}
        href={href}
        onClick={handleClick}
        className={cn(
          rest.className,
          "cursor-pointer no-underline hover:underline hover:decoration-blue-500/50 dark:hover:decoration-blue-400/50",
        )}
        title={`Open ${href?.slice("band-file:".length)}`}
      >
        {children}
      </a>
    );
  }

  // Default link rendering — open external links in system browser (desktop)
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Remark plugin — detect file paths with line indicators in plain text
// ---------------------------------------------------------------------------

/**
 * Regex to match file paths with line indicators in plain text.
 *
 * Matches patterns like:
 *   src/main.rs:42
 *   app.tsx:10-20
 *   components/Button.tsx:15:8
 *   ./src/utils.ts:5
 *   ../lib/index.js:100
 *
 * Requires a line indicator (`:number`) to avoid false positives in
 * plain text. The path must contain a file extension.
 */
const FILE_PATH_WITH_LINE_RE =
  /(?:^|(?<=[\s(,[\]]))(?:\.{0,2}\/)?(?:[a-zA-Z0-9_@./-]*\/)?[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+:\d+(?:[-:]\d+)?(?=$|[\s),.\]!?;])/g;

/** Node types whose children should not be processed */
const SKIP_PARENTS = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "table",
  "tableRow",
  "tableCell",
]);

// biome-ignore lint/suspicious/noExplicitAny: unified plugin operates on untyped AST nodes
type MdastNode = any;

/**
 * Walk the mdast tree and call `visitor` on each text node, providing
 * the parent so the visitor can splice replacements into the parent's
 * children array.
 */
function walkText(
  node: MdastNode,
  visitor: (text: MdastNode, parent: MdastNode, index: number) => void,
  parent?: MdastNode,
  index?: number,
) {
  if (SKIP_PARENTS.has(node.type)) return;

  if (node.type === "text" && parent) {
    visitor(node, parent, index!);
    return;
  }

  if (Array.isArray(node.children)) {
    // Walk in reverse so splicing doesn't shift indices
    for (let i = node.children.length - 1; i >= 0; i--) {
      walkText(node.children[i], visitor, node, i);
    }
  }
}

/**
 * Remark plugin that detects file paths with line indicators in plain
 * text and wraps them in link nodes with `band-file:` protocol.
 */
function remarkFileLinks() {
  return (tree: MdastNode) => {
    walkText(tree, (textNode, parent, index) => {
      const value: string = textNode.value;
      if (!value) return;

      FILE_PATH_WITH_LINE_RE.lastIndex = 0;
      const parts: MdastNode[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null = FILE_PATH_WITH_LINE_RE.exec(value);

      while (match !== null) {
        const matchText = match[0];
        const matchStart = match.index;
        const matchEnd = matchStart + matchText.length;
        // Advance the iterator before any `continue` so the loop can never
        // spin forever on a match that fails the sanity check below.  Hit by
        // strings like "127.0.0.1:5173" — the regex matches them but
        // isFilePath rejects, and the previous code skipped the
        // re-assignment, hanging the chat tab.
        match = FILE_PATH_WITH_LINE_RE.exec(value);

        // Quick sanity check — must parse as a valid file path
        if (!isFilePath(matchText)) continue;

        // Add preceding text
        if (matchStart > lastIndex) {
          parts.push({ type: "text", value: value.slice(lastIndex, matchStart) });
        }

        // Add link node wrapping the matched file path
        parts.push({
          type: "link",
          url: `band-file:${matchText}`,
          children: [{ type: "text", value: matchText }],
        });

        lastIndex = matchEnd;
      }

      // No matches — leave the text node unchanged
      if (parts.length === 0) return;

      // Add trailing text
      if (lastIndex < value.length) {
        parts.push({ type: "text", value: value.slice(lastIndex) });
      }

      // Replace the original text node with the new parts
      parent.children.splice(index, 1, ...parts);
    });
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** Component overrides for Streamdown — only `a` (no `code` override to
 *  avoid conflicting with the @streamdown/code Shiki plugin). */
export const fileLinkComponents: Components = {
  a: FileLinkedAnchor,
};

/** Remark plugins: detect file paths in plain text. */
export const fileLinkRemarkPlugins = [remarkFileLinks];

/** Rehype plugins: wrap inline `<code>` file paths in `<a>` links. */
export const fileLinkRehypePlugins = [rehypeFileLinkedCode];

/** URL transform that allows `band-file:` protocol through the sanitizer. */
export const fileLinkUrlTransform: UrlTransform = (url, key, node) => {
  if (url.startsWith("band-file:")) return url;
  return defaultUrlTransform(url, key, node);
};
