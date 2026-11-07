/** The editor selection the hub keeps per worktree (`editors.selection`) and how a message carries it. */

import { selectionBlockText, selectionLabel } from "@band-app/shared/editor-selection-block";

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
  return selectionLabel(info.file, info.selection.label);
}

/** The block added after the user's text. */
export function selectionBlock(info: EditorSelectionInfo): string {
  return selectionBlockText(info);
}

/** The message to send: the user's text, then the selection block when the chip is kept. */
export function withSelection(text: string, info: EditorSelectionInfo | null): string {
  if (!info) return text;
  const block = selectionBlock(info);
  return text.trim() ? `${text}\n\n${block}` : block;
}
