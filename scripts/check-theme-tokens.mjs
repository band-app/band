#!/usr/bin/env node
// Fails when UI code hardcodes a color. Colors come from the semantic tokens in
// apps/web/src/styles/globals.css (bg-selection, text-success, var(--git-added), ...), so
// Settings > Appearance can restyle every surface.
//
// Flags in .ts and .tsx files:
//   - Tailwind palette classes (bg-blue-500, text-white, dark:border-gray-700, ...)
//   - hex literals and rgb()/rgba()/hsl()/hsla()/oklch()/oklab() calls
// Skips comment lines, tests, the theme engine (apps/web/src/lib/theme), and:
//   - a line carrying `theme-lint-ignore-line: <reason>`, or the line after one
//   - a file with `theme-lint-ignore-file: <reason>` in its first 5 lines
// Usage: check-theme-tokens.mjs [dir ...]   (default: the UI source directories)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDirs = ["apps/web/src", "packages/ui/src", "plugins/github/src"];
const skipPaths = [/(^|\/)apps\/web\/src\/lib\/theme\//, /\.(test|spec)\.tsx?$/, /routeTree\.gen\.ts$/];

const COLORS =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black";
const UTILITIES =
  "bg|text|border|ring|ring-offset|fill|stroke|from|to|via|outline|divide|decoration|shadow|accent|caret|placeholder";
const paletteClass = new RegExp(
  `(?<![\\w-])(?:[a-z0-9-]+:)*-?(?:${UTILITIES})-(?:${COLORS})(?:-\\d{2,3})?(?![\\w-])`,
);
// 3 and 4 digit hex with no letter (#123, #617) is an issue number far more often than a color.
const hexColor = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9]*[a-fA-F])[0-9a-fA-F]{3,4})(?![\w-])/;
const colorFunction = /(?<![\w-])(?:rgba?|hsla?|oklch|oklab)\(\s*[\d.]/;

const message =
  "Hardcoded color. Use a semantic token from apps/web/src/styles/globals.css " +
  "(bg-selection, text-success, text-git-added, bg-diff-added-bg, var(--syntax-keyword), ...). " +
  "A color that must not follow the theme needs `theme-lint-ignore-line: <reason>` (or -file).";

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(name)) yield full;
  }
}

const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line) && !/^\s*\{\/\*.*\*\/\}.*</.test(line);

export function checkSource(text) {
  const lines = text.split("\n");
  if (lines.slice(0, 5).some((l) => l.includes("theme-lint-ignore-file"))) return [];
  const hits = [];
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (line.includes("theme-lint-ignore-line")) return;
    if (i > 0 && (lines[i - 1] ?? "").includes("theme-lint-ignore-line")) return;
    const code = line.replace(/\s\/\/.*$/, "");
    const m = paletteClass.exec(code) ?? hexColor.exec(code) ?? colorFunction.exec(code);
    if (m) hits.push({ line: i + 1, match: m[0], text: line.trim() });
  });
  return hits;
}

const dirs = process.argv.length > 2 ? process.argv.slice(2).map((d) => resolve(d)) : defaultDirs.map((d) => join(root, d));
let failures = 0;
for (const dir of dirs) {
  for (const file of walk(dir)) {
    const rel = relative(root, file);
    if (skipPaths.some((re) => re.test(rel))) continue;
    for (const hit of checkSource(readFileSync(file, "utf8"))) {
      if (failures === 0) console.error(message);
      failures++;
      console.error(`${rel}:${hit.line}: ${hit.match}   ${hit.text.slice(0, 120)}`);
    }
  }
}
if (failures > 0) {
  console.error(`\n${failures} hardcoded color${failures === 1 ? "" : "s"}.`);
  process.exit(1);
}
