/**
 * Removes secrets from text before it is written into a context repo. The hub
 * runs it on everything the context tools and the capture job write. Plan step
 * 5.2 adds the scan on worker pushes and should share these patterns.
 */

const PLACEHOLDER = "[redacted]";

const PATTERNS: RegExp[] = [
  // PEM private keys, whole block.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Band tokens: device, worker bootstrap and session, MCP proxy session, relay.
  /\b(?:bdt|bwb|bws|mcp|brt)_[A-Za-z0-9_-]{8,}/g,
  // GitHub, GitLab, Slack, Stripe, OpenAI/Anthropic style keys.
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Credentials inside URLs: scheme://user:password@host.
  /(?<=:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/g,
];

// `name = value` or `"name": "value"` where the name says it is a secret.
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, PLACEHOLDER);
  out = out.replace(BEARER, `$1 ${PLACEHOLDER}`);
  out = out.replace(ASSIGNMENT, (match, name: string, sep: string, value: string) =>
    value === PLACEHOLDER || value.startsWith("[redacted") ? match : `${name}${sep}${PLACEHOLDER}`,
  );
  return out;
}
