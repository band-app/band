/**
 * Where dictated text goes: over the selection of the composer's draft, spaced from the words
 * around it. Shared by the web and mobile composers.
 */

/** The text with `insert` placed over the selection, spaced from its neighbours. */
export function insertAtSelection(
  value: string,
  start: number,
  end: number,
  insert: string,
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before !== "" && !/\s$/.test(before) && !/^\s/.test(insert) ? " " : "";
  const tail = after !== "" && !/^[\s.,;:!?)\]}]/.test(after) && !/\s$/.test(insert) ? " " : "";
  const next = `${before}${lead}${insert}${tail}${after}`;
  return { value: next, caret: before.length + lead.length + insert.length };
}
