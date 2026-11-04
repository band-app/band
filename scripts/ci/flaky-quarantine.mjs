// The quarantine list: tests that flaked often enough to stop blocking merges.
// Format of .github/flaky-quarantine.txt, one test per line:
//
//   apps/web/e2e/some.spec.ts › describe › test name  # 1234
//
// The id is `<repo-relative file> › <describe titles> › <test title>`, the same text
// the flaky issue carries after "flaky: ". The number after `#` is that issue.
// Lines that start with `#` are comments.
//
// BAND_FLAKY_QUARANTINE picks what a run does with the list:
//   exclude  skip the listed tests (the default when CI is set)
//   only     run just the listed tests (the non-blocking quarantine job)
//   off      ignore the list (the default outside CI)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SEPARATOR = " › ";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_QUARANTINE_FILE = join(repoRoot, ".github/flaky-quarantine.txt");

export function parseQuarantine(text) {
  const entries = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(.*?)\s+#\s*(\d+)\s*$/);
    const id = (m ? m[1] : line).trim();
    const parts = id.split(SEPARATOR);
    if (parts.length < 2) continue;
    entries.push({ id, file: parts[0], titles: parts.slice(1), issue: m ? Number(m[2]) : null });
  }
  return entries;
}

export function readQuarantine(file = process.env.BAND_FLAKY_QUARANTINE_FILE ?? DEFAULT_QUARANTINE_FILE) {
  return existsSync(file) ? parseQuarantine(readFileSync(file, "utf8")) : [];
}

export function quarantineMode(env = process.env) {
  const mode = env.BAND_FLAKY_QUARANTINE;
  if (mode === "exclude" || mode === "only" || mode === "off") return mode;
  return env.CI ? "exclude" : "off";
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Entries whose file sits under `prefix` (for example "apps/hub/"), with the file made relative to it. */
export function entriesUnder(entries, prefix) {
  return entries
    .filter((e) => e.file.startsWith(prefix))
    .map((e) => ({ ...e, file: relative(prefix, e.file) }));
}

/** Playwright `grep` / `grepInvert` for entries already relative to the e2e directory. */
export function playwrightFilter(entries, mode) {
  if (mode === "off") return {};
  // Playwright matches the regex against the title path joined by spaces:
  // "<project> <file> <describe titles> <test title>".
  const patterns = entries.map(
    (e) => `${escapeRegex(e.file.split("/").pop())} ${e.titles.map(escapeRegex).join(" ")}$`,
  );
  if (mode === "exclude") return patterns.length ? { grepInvert: new RegExp(patterns.join("|")) } : {};
  return { grep: new RegExp(patterns.length ? patterns.join("|") : "(?!)") };
}

/** Vitest `include` and `testNamePattern` for entries already relative to the package. */
export function vitestFilter(entries, mode) {
  if (mode === "off") return {};
  // Vitest matches the pattern against the suite and test names joined by a space.
  const names = entries.map((e) => `${e.titles.map(escapeRegex).join(" ")}$`);
  if (mode === "exclude") return names.length ? { testNamePattern: `^(?!.*(?:${names.join("|")}))` } : {};
  return {
    include: [...new Set(entries.map((e) => e.file))],
    testNamePattern: names.length ? `(?:${names.join("|")})` : undefined,
    passWithNoTests: true,
  };
}
