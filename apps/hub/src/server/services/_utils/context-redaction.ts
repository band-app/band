/**
 * Redaction scan for context content. A context is shared with every worker
 * that may pull it, so text that looks like a credential is refused before it
 * is committed. The scan reports the kind of match and its line, never the
 * matched text. The rules are the ones a host applies before it pushes
 * (`scanText` in `@band-app/host-api`), with the stricter assignment check:
 * a person typing into the editor gets told about any `password: <12+ chars>`.
 */

import { RULE_LABELS, SECRET_PATTERNS, scanText } from "@band-app/host-api";

export interface RedactionFinding {
  kind: string;
  line: number;
}

/** The credential-shaped matches in `text`, one per kind and line. */
export function scanForSecrets(text: string): RedactionFinding[] {
  return scanText("", text, [], { looseAssignments: true }).map((f) => ({
    kind: RULE_LABELS[f.rule] ?? f.rule,
    line: f.line,
  }));
}

const PLACEHOLDER = "[redacted]";

// Shapes the scan above does not refuse but the context tools still strip.
const EXTRA_PATTERNS: RegExp[] = [
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Credentials inside URLs: scheme://user:password@host.
  /(?<=:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/g,
];

// `name = value` where the name says it is a secret. Looser than the scan: the
// context tools replace the value, so a false match costs a word, not a refusal.
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;

const globally = (re: RegExp) =>
  new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

/**
 * `text` with every credential-shaped match replaced by `[redacted]`. The
 * context tools and the capture job use it, because they write text an agent
 * produced and cannot send a refusal back to a person. It reuses the patterns
 * of `scanForSecrets`, so the two agree on what a secret is.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [kind, pattern] of SECRET_PATTERNS) {
    const re = globally(pattern);
    out =
      kind === "private key"
        ? out.replace(
            /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
            PLACEHOLDER,
          )
        : kind === "bearer token"
          ? out.replace(re, `Bearer ${PLACEHOLDER}`)
          : out.replace(re, PLACEHOLDER);
  }
  for (const pattern of EXTRA_PATTERNS) out = out.replace(pattern, PLACEHOLDER);
  return out.replace(ASSIGNMENT, (match, name: string, sep: string, value: string) =>
    value.startsWith("[redacted") ? match : `${name}${sep}${PLACEHOLDER}`,
  );
}
