/**
 * The redaction scan that runs before a context change is pushed to the hub
 * (plan step 5.2). It looks for the shapes of common credentials, for
 * assignments of a high-entropy value to a secret-sounding name, and for any
 * value the hub's vault holds (the hub sends fingerprints, never the values).
 * A finding names the rule and the line, never the matched text.
 */

import type { ContextFinding, SecretFingerprint } from "./host";
import { sha256Hex } from "./secret-fingerprint";

interface Rule {
  id: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { id: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  {
    id: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: "slack-token", pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/ },
  { id: "api-key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/ },
  { id: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
  { id: "band-token", pattern: /\b(?:bdt|bwb|bws|brt|mcp)_[A-Za-z0-9_-]{16,}/ },
];

/** What the hub's context editor shows for a rule. */
export const RULE_LABELS: Record<string, string> = {
  "aws-access-key": "AWS access key id",
  "github-token": "GitHub token",
  "private-key": "private key",
  jwt: "JWT",
  "slack-token": "Slack token",
  "api-key": "Anthropic or OpenAI key",
  "bearer-token": "bearer token",
  "band-token": "Band token",
  "high-entropy-assignment": "credential assignment",
  "credential-assignment": "credential assignment",
  "vault-secret": "vault secret",
};

/** The fixed-shape rules as [label, pattern], for a caller that replaces matches instead of reporting them. */
export const SECRET_PATTERNS: Array<[string, RegExp]> = RULES.map((r) => [
  RULE_LABELS[r.id] ?? r.id,
  r.pattern,
]);

/** Any value of 12 or more characters after a secret-sounding name, whatever its entropy. */
const LOOSE_ASSIGNMENT =
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{12,}/i;

const ASSIGNMENT =
  /(?:secret|token|passw(?:or)?d|passwd|api[_-]?key|apikey|credential|private[_-]?key|auth)\w*["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_.-]{20,})/i;
const MIN_ENTROPY = 3.5;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function vaultHit(line: string, secrets: SecretFingerprint[]): boolean {
  for (const secret of secrets) {
    let from = line.indexOf(secret.prefix);
    while (from !== -1) {
      const candidate = line.slice(from, from + secret.length);
      if (candidate.length === secret.length && sha256Hex(candidate) === secret.sha256) {
        return true;
      }
      from = line.indexOf(secret.prefix, from + 1);
    }
  }
  return false;
}

/** Scans one file's text. Returns at most one finding per line and rule. */
export function scanText(
  path: string,
  text: string,
  secrets: SecretFingerprint[] = [],
  options: { looseAssignments?: boolean } = {},
): ContextFinding[] {
  const findings: ContextFinding[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const seen = new Set<string>();
    const add = (rule: string) => {
      if (seen.has(rule)) return;
      seen.add(rule);
      findings.push({ path, rule, line: i + 1 });
    };
    for (const rule of RULES) if (rule.pattern.test(line)) add(rule.id);
    const assigned = ASSIGNMENT.exec(line)?.[1];
    if (
      assigned &&
      /[A-Za-z]/.test(assigned) &&
      /\d/.test(assigned) &&
      entropy(assigned) >= MIN_ENTROPY
    ) {
      add("high-entropy-assignment");
    }
    if (options.looseAssignments && LOOSE_ASSIGNMENT.test(line)) add("credential-assignment");
    if (secrets.length > 0 && vaultHit(line, secrets)) add("vault-secret");
  });
  return findings;
}
