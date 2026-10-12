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

export function highlight(code: string, lang: string): CodeRun[] {
  const name = languageOf(lang);
  if (!name || code.length > HIGHLIGHT_LIMIT) return [{ text: code }];
  try {
    const out: CodeRun[] = [];
    walk(lowlight.highlight(name, code) as Node, undefined, out);
    return out;
  } catch {
    return [{ text: code }];
  }
}
