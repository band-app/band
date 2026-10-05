/**
 * The always-loaded context for an agent session (plan step 5.3), read from a
 * host's context working copies: the user's `preferences.md`, each project's
 * `notes.md`, and an index of the other files with a one-line description each.
 *
 * The whole text stays within a line budget (200 by default, the cap Claude
 * Code puts on its own auto memory). A file longer than its share is cut, with a
 * note that names the path of the full file. The index takes what the files
 * leave, up to a fixed reserve.
 */

import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextPreamble, ContextPreambleRequest, ContextSpec } from "@band-app/host-api";

export const DEFAULT_PREAMBLE_LINES = 200;
const INDEX_RESERVE_LINES = 40;
const MAX_INDEX_DEPTH = 3;
const MAX_FILE_BYTES = 64 * 1024;
const SKIPPED_DIRS = new Set([".git", "media", "memory", "node_modules"]);
const SKIPPED_FILES = new Set([".gitkeep", ".gitattributes", "preferences.md", "notes.md"]);

interface Loaded {
  title: string;
  /** Absolute path of the file, for the truncation note. */
  path: string;
  lines: string[];
}

async function readText(path: string): Promise<string | null> {
  try {
    // A context repo can hold a symlink to a host file. Read regular files only.
    if (!(await lstat(path)).isFile()) return null;
    const buf = await readFile(path);
    return buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/** `description:` from YAML frontmatter, else the first heading, else null. */
export function describeFile(text: string): string | null {
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  if (front) {
    const d = /^description:\s*(.+)$/m.exec(front[1]);
    if (d) return d[1].trim().replace(/^["']|["']$/g, "");
  }
  const body = front ? text.slice(front[0].length) : text;
  const h = /^#{1,6}\s+(.+)$/m.exec(body);
  return h ? h[1].trim() : null;
}

/** Shares `budget` lines among `sizes`: a short file keeps its length, the rest split what is left. */
function allocate(sizes: number[], budget: number): number[] {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  const out = new Array<number>(sizes.length).fill(0);
  let left = Math.max(0, budget);
  order.forEach((i, n) => {
    const share = Math.floor(left / (order.length - n));
    out[i] = Math.min(sizes[i], share);
    left -= out[i];
  });
  return out;
}

async function indexLines(root: string, label: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name) && depth < MAX_INDEX_DEPTH) {
          await walk(join(dir, e.name), path, depth + 1);
        }
      } else if (e.isFile() && !SKIPPED_FILES.has(e.name)) {
        const text = e.name.endsWith(".md") ? await readText(join(dir, e.name)) : null;
        const desc = text ? describeFile(text) : null;
        out.push(desc ? `- ${label}/${path}: ${desc}` : `- ${label}/${path}`);
      }
    }
  }
  await walk(root, "", 1);
  return out;
}

export async function buildPreamble(
  request: ContextPreambleRequest,
  dirOf: (spec: ContextSpec) => string,
): Promise<ContextPreamble> {
  const budget = request.maxLines ?? DEFAULT_PREAMBLE_LINES;
  const files: Loaded[] = [];
  const roots: Array<{ label: string; dir: string }> = [];
  let memoryDir: string | null = null;

  for (const spec of request.contexts) {
    const dir = dirOf(spec);
    const label = spec.kind === "user" ? "user" : spec.name;
    roots.push({ label, dir });
    const name = spec.kind === "user" ? "preferences.md" : "notes.md";
    const text = await readText(join(dir, name));
    if (text !== null && text.trim() !== "") {
      files.push({
        title: spec.kind === "user" ? "Your preferences" : `Notes for the ${spec.name} project`,
        path: join(dir, name),
        lines: splitLines(text),
      });
    }
    if (spec.kind === "project" && memoryDir === null) memoryDir = join(dir, "memory");
  }

  const index: string[] = [];
  for (const r of roots) index.push(...(await indexLines(r.dir, r.label)));

  if (files.length === 0 && index.length === 0) return { text: "", memoryDir };

  // Each file takes a heading, a blank line, a trailing blank line and, when cut, a note.
  const frame = files.length * 4;
  const indexShown = Math.min(index.length, INDEX_RESERVE_LINES - 4);
  const indexCost = index.length > 0 ? 4 + indexShown + (index.length > indexShown ? 1 : 0) : 0;
  const room = budget - 2 - frame - indexCost;
  const shares = allocate(
    files.map((f) => f.lines.length),
    room,
  );

  const out: string[] = ["# Band context", ""];
  files.forEach((f, i) => {
    out.push(`## ${f.title}`, "");
    out.push(...f.lines.slice(0, shares[i]));
    if (shares[i] < f.lines.length) {
      out.push(`[Cut: ${f.lines.length - shares[i]} more lines. Read the full file at ${f.path}]`);
    }
    out.push("");
  });
  if (index.length > 0) {
    out.push(
      "## Index",
      "",
      `Other files in these context folders (${roots.map((r) => `${r.label}: ${r.dir}`).join("; ")}). Read them when a task needs them.`,
      ...index.slice(0, indexShown),
    );
    if (index.length > indexShown)
      out.push(`[${index.length - indexShown} more files, list the folders]`);
  }
  return { text: out.join("\n").trimEnd(), memoryDir };
}
