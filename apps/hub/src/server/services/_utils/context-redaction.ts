/**
 * Redaction scan for context content. A context is shared with every worker
 * that may pull it, so text that looks like a credential is refused before it
 * is committed. The scan reports the kind of match and its line, never the
 * matched text. The rules are the ones a host applies before it pushes
 * (`scanText` in `@band-app/host-api`), with the stricter assignment check:
 * a person typing into the editor gets told about any `password: <12+ chars>`.
 */

import { RULE_LABELS, scanText } from "@band-app/host-api";

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
