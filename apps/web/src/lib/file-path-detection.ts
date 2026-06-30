// ---------------------------------------------------------------------------
// File path detection
//
// Pure helpers (no React / no DOM) for deciding whether an arbitrary string
// looks like a file path worth turning into a clickable link. Shared by the
// chat renderer (`ai-elements/file-link-components.tsx`) and the terminal link
// provider (`terminal-file-links.ts`) so both surfaces agree on what counts as
// a file reference. Keep this module dependency-light so it can be unit-tested
// in isolation.
// ---------------------------------------------------------------------------

import { parseFileLocation } from "../dashboard/lib/file-location";

// ---------------------------------------------------------------------------
// Known file extensions (derived from dashboard/lib/file-icon.ts)
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

/**
 * Checks if a string looks like a file path that should be linked.
 *
 * For inline code (backtick-wrapped), matches file paths with or without
 * line indicators. For plain text (remark plugin) and terminal output,
 * callers should only pass strings that already have a line indicator
 * unless the path contains a slash or is a well-known filename.
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

  // Derive the basename once (one split), then the extension from it.
  const name = filePath.split("/").pop() ?? filePath;
  const basename = name.toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
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
