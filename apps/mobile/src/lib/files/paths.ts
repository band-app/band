/** Worktree-relative path helpers. Paths use `/` and have no leading slash; the root is "". */

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function baseName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

/** The folder part of a path, "" for a file in the root. */
export function dirName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

export type FileKind = "image" | "video" | "markdown" | "pdf" | "code";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "heic", "avif"]);
const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "webm"]);
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);

function extOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** How the viewer shows a file, chosen by its extension. SVG is text, so it stays code. */
export function fileKind(path: string): FileKind {
  const ext = extOf(path);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (ext === "pdf") return "pdf";
  return "code";
}

/** highlight.js names for extensions and file names the hub's own language map lacks. */
const LANGUAGES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  graphql: "graphql",
  lua: "lua",
  r: "r",
  pl: "perl",
  diff: "diff",
  patch: "diff",
  mk: "makefile",
};

const NAMES: Record<string, string> = {
  Makefile: "makefile",
  makefile: "makefile",
  Dockerfile: "dockerfile",
};

/** The language to highlight with, "" when none is known. `hint` is the hub's own guess. */
export function languageForPath(path: string, hint?: string): string {
  return NAMES[baseName(path)] ?? LANGUAGES[extOf(path)] ?? hint ?? "";
}
