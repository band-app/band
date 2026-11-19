// Label rules shared by chats and worktrees (issue #520).

/**
 * Reserved prefix for Band-internal label keys. Writes to keys with this
 * prefix are rejected from user-facing surfaces (CLI flags, future UI) — only
 * server-side code paths (e.g. the cronjob scheduler) may set them.
 * External callers should compose with `BAND_CRON_ID_LABEL`
 * (and future siblings) rather than constructing keys from the prefix.
 */
export const BAND_LABEL_PREFIX = "band:";

/** Maximum number of label keys per chat or worktree. */
export const MAX_LABEL_KEYS = 20;

/** Maximum length of a label value. */
const MAX_LABEL_VALUE_LENGTH = 256;

/** Regex for valid label keys: alphanumerics, `_`, `:`, `-`; 1-64 chars.
 *
 * The hyphen sits at the end of the character class as a literal —
 * Biome's `noUselessEscapeInRegex` rule prohibits writing it as `\-`.
 * Reordering the `_`, `:`, `-` triple would silently turn the class
 * into a range, so keep the hyphen last. */
const LABEL_KEY_REGEX = /^[a-zA-Z0-9_:-]{1,64}$/;

/** Printable-ASCII regex used to validate label values. */
const PRINTABLE_VALUE_REGEX = /^[\x20-\x7E]+$/;

/**
 * Thrown when a labels payload fails validation. Callers (tRPC routes, CLI
 * surface, internal helpers) should let this propagate so the framework
 * maps it to a 400-class response — the helpful message in `.message`
 * already names the specific rule that was violated.
 */
export class InvalidLabelsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLabelsError";
  }
}

export interface LabelValidationOptions {
  /**
   * When `true`, writes to keys starting with `band:` are rejected. tRPC
   * routes and other user-facing surfaces pass `true`; the cronjob scheduler
   * (and any other internal caller that legitimately needs to write a
   * reserved key) passes `false`.
   */
  rejectReservedPrefix: boolean;
}

/**
 * Validate a labels record. Returns a fresh, byte-sorted copy on success so
 * call sites can chain `labels = validateLabels(input, ...)`. Throws
 * `InvalidLabelsError` with a precise message on failure.
 *
 * Rules:
 *  - At most 20 keys.
 *  - Keys match `/^[a-zA-Z0-9_:-]{1,64}$/` (colons allowed for namespacing).
 *  - Values are printable ASCII (0x20–0x7E), 1–256 chars, non-empty.
 *  - When `rejectReservedPrefix: true`, `band:`-prefixed keys are forbidden.
 */
export function validateLabels(
  labels: Record<string, string>,
  options: LabelValidationOptions,
): Record<string, string> {
  const keys = Object.keys(labels);
  if (keys.length > MAX_LABEL_KEYS) {
    throw new InvalidLabelsError(
      `labels: too many keys (${keys.length}); max is ${MAX_LABEL_KEYS}`,
    );
  }
  for (const key of keys) {
    // No standalone empty-key guard — `LABEL_KEY_REGEX` already rejects
    // empty strings via the `{1,64}` length quantifier, and the regex
    // message is self-explanatory (`key "" must match /^.../`).
    if (!LABEL_KEY_REGEX.test(key)) {
      throw new InvalidLabelsError(`labels: key "${key}" must match ${LABEL_KEY_REGEX}`);
    }
    if (options.rejectReservedPrefix && key.startsWith(BAND_LABEL_PREFIX)) {
      throw new InvalidLabelsError(
        `labels: key "${key}" uses reserved "${BAND_LABEL_PREFIX}" prefix`,
      );
    }
    const value = labels[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new InvalidLabelsError(`labels: value for "${key}" must be a non-empty string`);
    }
    if (value.length > MAX_LABEL_VALUE_LENGTH) {
      throw new InvalidLabelsError(
        `labels: value for "${key}" exceeds ${MAX_LABEL_VALUE_LENGTH} chars`,
      );
    }
    if (!PRINTABLE_VALUE_REGEX.test(value)) {
      throw new InvalidLabelsError(
        `labels: value for "${key}" must be printable ASCII (0x20-0x7E)`,
      );
    }
  }
  // Return a fresh object whose keys are sorted by byte-order (codepoint)
  // comparison. JS preserves insertion order for string keys, so this
  // gives every downstream consumer (JSON.stringify for the DB blob, tRPC
  // serialization for `chats.list`, the CLI table renderer) a stable
  // iteration — without each consumer needing to sort independently.
  // Cost is O(k log k) at write time with k ≤ 20.
  //
  // Byte-order — not `localeCompare` — so the order matches Rust's
  // `String::cmp` used by the CLI's `format_labels_cell`. Under some V8
  // locales `localeCompare` reorders even ASCII `-` / `:` (both permitted
  // by `LABEL_KEY_REGEX`) relative to byte order, which would surface as
  // the CLI table showing the same chat in a different key order than
  // the JSON output.
  const sorted: Record<string, string> = {};
  for (const key of keys.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    sorted[key] = labels[key];
  }
  return sorted;
}
