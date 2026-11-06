/**
 * The text block a chat message carries when an editor selection is kept, and its parser. Web and
 * mobile both write the block with `selectionBlockText` and read it back with
 * `parseSelectionBlock`, so the two cannot drift.
 */

export interface SelectionBlockInfo {
  file: string;
  extensionId: string;
  editorId: string;
  selection: { address: string; label: string; text?: string };
}

/** `<label> · <file name>`, the chip's text. */
export function selectionLabel(file: string, label: string): string {
  const at = file.lastIndexOf("/");
  return `${label} · ${at < 0 ? file : file.slice(at + 1)}`;
}

const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ");

/** `Selected in <file> (<ext>/<editor>): <label>\nAddress: <address>[\n<text>]`. */
export function selectionBlockText(info: SelectionBlockInfo): string {
  const head = `Selected in ${oneLine(info.file)} (${info.extensionId}/${info.editorId}): ${oneLine(info.selection.label)}\nAddress: ${oneLine(info.selection.address)}`;
  return info.selection.text ? `${head}\n${info.selection.text}` : head;
}

export interface ParsedSelectionBlock {
  /** The person's text before the block. */
  body: string;
  file: string;
  label: string;
  address: string;
  text?: string;
  /** `<label> · <file name>`. */
  chipLabel: string;
}

const HEADER = /^Selected in (.+) \(([^\s/()]+)\/([^\s/()]+)\): (.*)$/;

/**
 * Splits a sent message into the person's text and the trailing selection block. Returns null
 * unless the message ends with a block in exactly the format `selectionBlockText` writes,
 * starting at the beginning of the message or after a blank line.
 */
export function parseSelectionBlock(message: string): ParsedSelectionBlock | null {
  const lines = message.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (i > 0 && lines[i - 1] !== "") continue;
    if (i > 0 && i < 2) continue; // a body needs its text line before the blank line
    const header = HEADER.exec(lines[i] ?? "");
    const addressLine = lines[i + 1] ?? "";
    if (!header || !addressLine.startsWith("Address: ")) continue;
    const file = header[1] ?? "";
    const label = header[4] ?? "";
    const text = lines.slice(i + 2).join("\n");
    const body = i === 0 ? "" : lines.slice(0, i - 1).join("\n");
    return {
      body,
      file,
      label,
      address: addressLine.slice("Address: ".length),
      ...(text ? { text } : {}),
      chipLabel: selectionLabel(file, label),
    };
  }
  return null;
}
