import { parseFileLocation } from "@band-app/dashboard-core";
import { cn } from "@band-app/ui";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import {
  type Components,
  defaultUrlTransform,
  type ExtraProps,
  type UrlTransform,
} from "streamdown";

import { openExternalUrl } from "../../lib/open-external-url";

// ---------------------------------------------------------------------------
// Known file extensions (derived from dashboard-core file-icon.ts)
// ---------------------------------------------------------------------------

const KNOWN_EXTENSIONS = new Set([
  // Code
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "r",
  "lua",
  "zig",
  "mts",
  "cts",
  "ex",
  "exs",
  "erl",
  "hs",
  "scala",
  "clj",
  "dart",
  "vue",
  "svelte",
  // Web / markup
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "sass",
  // Data / config
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "xml",
  "csv",
  "graphql",
  "gql",
  "tf",
  "hcl",
  "env",
  "proto",
  // Text / docs
  "md",
  "mdx",
  "txt",
  "rst",
  "tex",
  "log",
  // Shell
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "ico",
  "bmp",
  "avif",
  // Database
  "sql",
  "sqlite",
  "db",
  // Config
  "editorconfig",
  "prettierrc",
  "eslintrc",
  "lock",
  // Package / archive
  "zip",
  "tar",
  "gz",
  "tgz",
  "wasm",
  // Misc
  "diff",
  "patch",
]);

const KNOWN_FILENAMES = new Set([
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "rakefile",
  "procfile",
  "gemfile",
  "vagrantfile",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".eslintrc",
  ".editorconfig",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
]);

// ---------------------------------------------------------------------------
// File path detection
// ---------------------------------------------------------------------------

function getExtension(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function getBasename(filePath: string): string {
  return (filePath.split("/").pop() ?? filePath).toLowerCase();
}

/**
 * Checks if a string looks like a file path that should be linked.
 *
 * For inline code (backtick-wrapped), matches file paths with or without
 * line indicators. For plain text (remark plugin), callers should only
 * pass strings that already have a line indicator.
 */
export function isFilePath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Reject URLs
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;

  const loc = parseFileLocation(trimmed);
  const filePath = loc.filePath;

  // Must not be empty after parsing
  if (!filePath) return false;

  const ext = getExtension(filePath);
  const basename = getBasename(filePath);
  const hasKnownExtension = KNOWN_EXTENSIONS.has(ext);
  const isKnownFilename = KNOWN_FILENAMES.has(basename);

  if (!hasKnownExtension && !isKnownFilename) return false;

  // For bare filenames without a path separator, require a line indicator
  // to avoid false positives (e.g. "utils.ts" alone is ambiguous, but
  // "utils.ts:42" is clearly a file reference)
  const hasSlash = filePath.includes("/");
  const hasLineIndicator = loc.line != null;

  if (!hasSlash && !hasLineIndicator && !isKnownFilename) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Custom event dispatcher
// ---------------------------------------------------------------------------

function dispatchOpenFile(filename: string) {
  window.dispatchEvent(new CustomEvent("band:open-file", { detail: { filename } }));
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

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (href) {
        e.preventDefault();
        e.stopPropagation();
        if (isBandFile) {
          dispatchOpenFile(href.slice("band-file:".length));
        } else {
          openExternalUrl(href);
        }
      }
    },
    [isBandFile, href],
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

  // Default link rendering — open external links in system browser (Tauri)
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
const SKIP_PARENTS = new Set(["code", "inlineCode", "link", "linkReference"]);

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

        // Quick sanity check — must parse as a valid file path
        if (!isFilePath(matchText)) continue;

        // Add preceding text
        if (match.index > lastIndex) {
          parts.push({ type: "text", value: value.slice(lastIndex, match.index) });
        }

        // Add link node wrapping the matched file path
        parts.push({
          type: "link",
          url: `band-file:${matchText}`,
          children: [{ type: "text", value: matchText }],
        });

        lastIndex = match.index + matchText.length;
        match = FILE_PATH_WITH_LINE_RE.exec(value);
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
