#!/usr/bin/env node
// Fails when an emoji or symbol glyph sits in apps/mobile/src. Icons are lucide icons
// (src/components/icon.tsx). A glyph that is content, not an icon, goes in ALLOWED with a reason.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

// Arrows, math and technical symbols, shapes, dingbats, emoji, and the single angle quotes.
const GLYPH = /[←-⯿\u{1F000}-\u{1FAFF}☀-➿‹›]/u;

/** path (relative to src) -> glyph -> why it stays text. */
export const ALLOWED = {
  "app/worktree/[id]/diff.tsx": {
    "−": "The minus of a line count in a file's subtitle, text like the plus before it.",
  },
  "app/worktree/[id]/changes.tsx": {
    "→": "Separates the old and new path of a rename, part of the path text.",
    "−": "The minus of the deletions count, text like the plus before it.",
  },
};

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

export function findGlyphs(dir = src) {
  const found = [];
  for (const file of files(dir)) {
    const rel = relative(dir, file);
    const allowed = ALLOWED[rel] ?? {};
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        for (const ch of line) {
          if (GLYPH.test(ch) && !(ch in allowed)) found.push(`${rel}:${i + 1} ${ch}`);
        }
      });
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findGlyphs();
  if (found.length > 0) {
    console.error(
      "Emoji or symbol glyphs in apps/mobile/src. Use a lucide icon (components/icon.tsx):",
    );
    for (const f of found) console.error(`  ${f}`);
    process.exit(1);
  }
}
