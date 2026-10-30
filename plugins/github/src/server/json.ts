export type Json = Record<string, unknown>;

export function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const SNIPPET_LIMIT = 200;

/** One line of text, cut to a length that fits an event summary. */
export function snippet(text: unknown): string {
  const flat = str(text).replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT)}...` : flat;
}

export const prKey = (repo: string, number: number) => `github:pr:${repo}#${number}`;
export const ciKey = (repo: string, branch: string) => `github:ci:${repo}@${branch}`;
