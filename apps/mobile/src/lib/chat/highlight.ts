/**
 * Syntax highlighting for code blocks, as colored runs of text. `lowlight` runs highlight.js's
 * grammars in plain JavaScript and returns a tree instead of HTML, so it works on Hermes, which
 * has no WebAssembly for Shiki's regex engine. The 37 common languages are bundled.
 */

import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

export interface CodeRun {
  text: string;
  /** The innermost highlight.js scope (`keyword`, `string`, ...), absent for plain text. */
  scope?: string;
}

/** Past this size a block renders plain, so one huge paste can't stall the JS thread. */
export const HIGHLIGHT_LIMIT = 20_000;

/** Fence names agents use that highlight.js knows under another name. */
const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  jsonc: "json",
  json5: "json",
  yml: "yaml",
  patch: "diff",
};

export function languageOf(lang: string): string | null {
  const name = ALIASES[lang] ?? lang;
  return name && lowlight.registered(name) ? name : null;
}

interface Node {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: Node[];
}

function walk(node: Node, scope: string | undefined, out: CodeRun[]): void {
  if (node.type === "text") {
    const text = node.value ?? "";
    const last = out[out.length - 1];
    if (last && last.scope === scope) last.text += text;
    else out.push(scope ? { text, scope } : { text });
    return;
  }
  let next = scope;
  const classes = node.properties?.className;
  if (Array.isArray(classes)) {
    const hljs = classes.find((c): c is string => typeof c === "string" && c.startsWith("hljs-"));
    if (hljs) next = hljs.slice("hljs-".length);
  }
  for (const child of node.children ?? []) walk(child, next, out);
}

/**
 * Recent results, so a list cell rebound to a row it showed before (scrolling back) doesn't
 * re-run lowlight. A Map keeps insertion order: the first key is the least recently used.
 */
const cache = new Map<string, CodeRun[]>();
const CACHE_SIZE = 64;

export function highlight(code: string, lang: string): CodeRun[] {
  const name = languageOf(lang);
  if (!name || code.length > HIGHLIGHT_LIMIT) return [{ text: code }];
  const key = `${name}\n${code}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let out: CodeRun[] = [];
  try {
    walk(lowlight.highlight(name, code) as Node, undefined, out);
  } catch {
    out = [{ text: code }];
  }
  cache.set(key, out);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return out;
}
