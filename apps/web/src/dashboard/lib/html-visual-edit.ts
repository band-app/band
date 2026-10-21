/** Message types the preview page and its parent exchange. They match the script the hub injects. */
export const VISUAL_EDIT_MESSAGE = {
  ready: "band-visual-edit:ready",
  commit: "band-visual-edit:commit",
  scroll: "band-visual-edit:scroll",
  editing: "band-visual-edit:editing",
  unavailable: "band-visual-edit:unavailable",
  mode: "band-visual-edit:mode",
  applied: "band-visual-edit:applied",
} as const;

export interface VisualEditCommit {
  start: number;
  end: number;
  oldText: string;
  newText: string;
}

/** Characters HTML collapses as white space. `\s` also matches non-breaking spaces, which are content. */
const HTML_SPACE = "[ \\t\\n\\r\\f]";
const LEADING = new RegExp(`^${HTML_SPACE}*`);
const TRAILING = new RegExp(`${HTML_SPACE}*$`);

/** The text a browser shows for a slice of HTML source: entities decoded, line breaks normalised. */
export function decodeHtmlText(raw: string): string {
  const holder = document.createElement("textarea");
  // The prefix keeps the parser from dropping a leading line feed.
  holder.innerHTML = `x${raw}`;
  return holder.value.slice(1).replace(/\r\n?/g, "\n");
}

export function encodeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/ /g, "&nbsp;");
}

export type PatchResult =
  | {
      ok: true;
      /** The whole file after the edit. */
      text: string;
      /** How much longer (or shorter) the edited range became. */
      delta: number;
      /** What a browser shows for the new range, for the page to put in the element. */
      shownText: string;
    }
  | { ok: false };

/**
 * Replace the text node at `start:end` of `source` with `newText`. Refuses
 * when the slice no longer shows `oldText`, which means the file changed after
 * the preview loaded. The white space around the text stays as the source had
 * it, so the indentation of the element is untouched.
 */
export function patchHtmlText(source: string, commit: VisualEditCommit): PatchResult {
  const { start, end, oldText, newText } = commit;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    return { ok: false };
  }
  if (end > source.length) return { ok: false };
  const raw = source.slice(start, end);
  if (decodeHtmlText(raw) !== oldText.replace(/\r\n?/g, "\n")) return { ok: false };
  const lead = LEADING.exec(raw)?.[0] ?? "";
  const trail = raw.length > lead.length ? (TRAILING.exec(raw)?.[0] ?? "") : "";
  const core = newText.replace(/\r\n?/g, "\n").replace(LEADING, "").replace(TRAILING, "");
  const encoded = encodeHtmlText(core);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const replacement = lead + (eol === "\n" ? encoded : encoded.replace(/\n/g, eol)) + trail;
  return {
    ok: true,
    text: source.slice(0, start) + replacement + source.slice(end),
    delta: replacement.length - raw.length,
    shownText: decodeHtmlText(replacement),
  };
}
