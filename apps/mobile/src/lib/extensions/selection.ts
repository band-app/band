/** The editor selection the hub keeps per worktree (`editors.selection`) and how a message carries it. */

export interface EditorSelectionInfo {
  file: string;
  extensionId: string;
  editorId: string;
  selection: { address: string; kind: string; label: string; text?: string };
  updatedAt?: number | string;
}

export function fileBaseName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

/** The chip text: `<label> · <file name>`. */
export function chipLabel(info: EditorSelectionInfo): string {
  return `${info.selection.label} · ${fileBaseName(info.file)}`;
}

/** The block added after the user's text. */
export function selectionBlock(info: EditorSelectionInfo): string {
  const head =
    `Selected in ${info.file} (${info.extensionId}/${info.editorId}): ${info.selection.label}\n` +
    `Address: ${info.selection.address}`;
  return info.selection.text ? `${head}\n${info.selection.text}` : head;
}

/** The message to send: the user's text, then the selection block when the chip is kept. */
export function withSelection(text: string, info: EditorSelectionInfo | null): string {
  if (!info) return text;
  const block = selectionBlock(info);
  return text.trim() ? `${text}\n\n${block}` : block;
}
