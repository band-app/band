const EXTENSION_MAP: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".json": "json",
  ".jsonc": "jsonc",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".md": "markdown",
  ".mdx": "mdx",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".svg": "xml",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "fish",
  ".ps1": "powershell",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".vue": "vue",
  ".svelte": "svelte",
  ".lua": "lua",
  ".r": "r",
  ".R": "r",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".scala": "scala",
  ".clj": "clojure",
  ".dockerfile": "dockerfile",
  ".tf": "hcl",
  ".hcl": "hcl",
  ".ini": "ini",
  ".env": "ini",
  ".txt": "plaintext",
  ".log": "plaintext",
  ".diff": "diff",
  ".patch": "diff",
  ".makefile": "makefile",
};

const FILENAME_MAP: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  Rakefile: "ruby",
  Gemfile: "ruby",
  Vagrantfile: "ruby",
};

export function extensionToLanguage(ext: string): string | undefined {
  return EXTENSION_MAP[ext];
}

export function filenameToLanguage(filename: string): string | undefined {
  return FILENAME_MAP[filename];
}

/**
 * Catalogue of languages the editor (CodeMirror) can syntax-highlight,
 * with the human-readable label shown in the language picker. Used by
 * `LanguagePickerDialog` (and the editor's status-bar language
 * indicator) to populate a searchable list.
 *
 * The `id` matches the lowercase canonical name accepted by
 * `loadLanguage` in `codemirror-setup.ts` — "Plain Text" maps to
 * `"plaintext"`, which `loadLanguage` resolves to `null` (no
 * highlighting), matching VS Code's behaviour.
 *
 * Order matters for the picker: "Plain Text" first because it's the
 * default for untitled tabs and the catch-all for unsupported
 * extensions, then everything else alphabetised by label.
 */
export interface SupportedLanguage {
  id: string;
  label: string;
}

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { id: "plaintext", label: "Plain Text" },
  { id: "bash", label: "Bash / Shell" },
  { id: "c", label: "C" },
  { id: "clojure", label: "Clojure" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  { id: "css", label: "CSS" },
  { id: "dart", label: "Dart" },
  { id: "diff", label: "Diff" },
  { id: "dockerfile", label: "Dockerfile" },
  { id: "elixir", label: "Elixir" },
  { id: "erlang", label: "Erlang" },
  { id: "go", label: "Go" },
  { id: "graphql", label: "GraphQL" },
  { id: "haskell", label: "Haskell" },
  { id: "hcl", label: "HCL / Terraform" },
  { id: "html", label: "HTML" },
  { id: "ini", label: "INI" },
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "jsonc", label: "JSON with Comments" },
  { id: "jsx", label: "JavaScript (JSX)" },
  { id: "kotlin", label: "Kotlin" },
  { id: "less", label: "Less" },
  { id: "lua", label: "Lua" },
  { id: "makefile", label: "Makefile" },
  { id: "markdown", label: "Markdown" },
  { id: "mdx", label: "MDX" },
  { id: "php", label: "PHP" },
  { id: "powershell", label: "PowerShell" },
  { id: "python", label: "Python" },
  { id: "r", label: "R" },
  { id: "ruby", label: "Ruby" },
  { id: "rust", label: "Rust" },
  { id: "sass", label: "Sass" },
  { id: "scala", label: "Scala" },
  { id: "scss", label: "SCSS" },
  { id: "sql", label: "SQL" },
  { id: "svelte", label: "Svelte" },
  { id: "swift", label: "Swift" },
  { id: "toml", label: "TOML" },
  { id: "typescript", label: "TypeScript" },
  { id: "tsx", label: "TypeScript (TSX)" },
  { id: "vue", label: "Vue" },
  { id: "xml", label: "XML" },
  { id: "yaml", label: "YAML" },
];

/**
 * Pre-built lookup so `languageLabel` is O(1) rather than O(n) over
 * `SUPPORTED_LANGUAGES`. The label is read on every render of the
 * status-bar language indicator, so although the list is small (~50
 * entries) and the per-call cost is negligible, the Map avoids a
 * scan-per-render and matches the style used by `EXTENSION_MAP` /
 * `FILENAME_MAP` above.
 */
const LANGUAGE_LABEL_BY_ID = new Map(SUPPORTED_LANGUAGES.map((l) => [l.id, l.label]));

/**
 * Resolve a language id to its human-readable label (e.g.
 * `"typescript"` → `"TypeScript"`). Falls back to a Title-Cased
 * version of the id when the language isn't in `SUPPORTED_LANGUAGES`
 * — that happens for legacy / less-common languages that exist in
 * `EXTENSION_MAP` but aren't surfaced in the picker. Callers always
 * pass a non-empty `id` (either `languageOverride`, `"plaintext"`,
 * or a `detectLanguage` result), so no empty-string guard is needed
 * — the title-case fallback handles unknown ids by surfacing a
 * recognisable string rather than masking a missing-language bug.
 */
export function languageLabel(id: string): string {
  const label = LANGUAGE_LABEL_BY_ID.get(id);
  if (label) return label;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Canonical extension for a language id, used to synthesize a virtual
 * filename for untitled tabs when an extension-driven tool (like the
 * server-side Prettier formatter) needs one. Returns `undefined` for
 * languages with no obvious canonical extension or for the
 * `"plaintext"` default — neither has a Prettier parser, so callers
 * should treat `undefined` as "skip extension-driven dispatch".
 *
 * Reverse of `EXTENSION_MAP`: where multiple extensions map to a
 * single language (e.g. `.cjs` / `.mjs` / `.js` → javascript), we
 * pick the most idiomatic one.
 */
const LANGUAGE_TO_EXTENSION: Record<string, string> = {
  javascript: ".js",
  jsx: ".jsx",
  typescript: ".ts",
  tsx: ".tsx",
  json: ".json",
  jsonc: ".jsonc",
  html: ".html",
  css: ".css",
  scss: ".scss",
  sass: ".sass",
  less: ".less",
  markdown: ".md",
  mdx: ".mdx",
  yaml: ".yaml",
  xml: ".xml",
  python: ".py",
  ruby: ".rb",
  rust: ".rs",
  go: ".go",
  java: ".java",
  kotlin: ".kt",
  swift: ".swift",
  c: ".c",
  cpp: ".cpp",
  csharp: ".cs",
  php: ".php",
  bash: ".sh",
  sql: ".sql",
  graphql: ".graphql",
  vue: ".vue",
  svelte: ".svelte",
  lua: ".lua",
  r: ".r",
  dart: ".dart",
  elixir: ".ex",
  erlang: ".erl",
  haskell: ".hs",
  scala: ".scala",
  clojure: ".clj",
  toml: ".toml",
  hcl: ".hcl",
  ini: ".ini",
  diff: ".diff",
};

export function languageToExtension(id: string): string | undefined {
  return LANGUAGE_TO_EXTENSION[id];
}
