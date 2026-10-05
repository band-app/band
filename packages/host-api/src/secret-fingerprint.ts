import { createHash } from "node:crypto";
import type { SecretFingerprint } from "./host";

const MIN_SECRET_LENGTH = 8;

/** SHA-256 of a string, hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * What the hub sends a host so its redaction scan can spot a vault secret
 * without holding it. A value shorter than 8 characters is too common to match
 * safely and gets no fingerprint. A value with several lines gets one fingerprint per line.
 */
export function fingerprintSecret(value: string): SecretFingerprint[] {
  const out: SecretFingerprint[] = [];
  for (const line of value.split(/\r?\n/)) {
    const text = line.trim();
    if (text.length < MIN_SECRET_LENGTH) continue;
    out.push({ length: text.length, prefix: text.slice(0, 4), sha256: sha256Hex(text) });
  }
  return out;
}
