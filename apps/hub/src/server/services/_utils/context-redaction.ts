/**
 * Redaction scan for context content. A context is shared with every worker
 * that may pull it, so text that looks like a credential is refused before it
 * is committed. The scan reports the kind of match and its line, never the
 * matched text.
 */

export interface RedactionFinding {
  kind: string;
  line: number;
}

const PATTERNS: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ["Anthropic or OpenAI key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Band token", /\b(?:bdt|bwb|bws|brt|mcp)_[A-Za-z0-9_-]{16,}\b/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
  [
    "credential assignment",
    /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{12,}/i,
  ],
];

/** The credential-shaped matches in `text`, one per kind and line. */
export function scanForSecrets(text: string): RedactionFinding[] {
  const findings: RedactionFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [kind, pattern] of PATTERNS) {
      if (pattern.test(lines[i] ?? "")) findings.push({ kind, line: i + 1 });
    }
  }
  return findings;
}
