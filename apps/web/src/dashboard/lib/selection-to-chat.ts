import { type Extension, Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { writeClipboardText } from "../../lib/clipboard";

/**
 * Payload dispatched via the `band:add-to-chat` window CustomEvent when the
 * user picks "Add to Chat" on a text selection inside a CodeMirror editor.
 */
export interface SelectionToChatDetail {
  filePath: string;
  selectedText: string;
  /** 1-based start line of the selection */
  startLine: number;
  /** 1-based end line of the selection */
  endLine: number;
}

/**
 * `band:add-to-chat` payload for a terminal selection: raw text with no file
 * behind it, which the chat input receives as a fenced code block.
 */
export interface TextToChatDetail {
  text: string;
}

/** Everything the `band:add-to-chat` intent can carry. */
export type AddToChatDetail = SelectionToChatDetail | TextToChatDetail;

/**
 * Payload dispatched via the `band:add-to-terminal` window CustomEvent when the
 * user picks "Add to Terminal" on a text selection. This is the *intent*
 * event: the selection context menu doesn't know which workspace it belongs to, so
 * the shared dockview layout (which does) listens, surfaces the terminal panel
 * for the active workspace, and re-dispatches the scoped `band:terminal-insert`
 * delivery event below. The reference string is pre-built so consumers stay
 * decoupled from the formatting logic.
 */
export interface AddToTerminalDetail {
  /**
   * The file reference to type into the terminal. The dispatcher appends a
   * trailing space to the bare `buildLineReference` output (so the result is
   * e.g. `"src/foo.ts:10-20 "`) to separate it from the next keystroke; the
   * builder itself never emits the space.
   */
  reference: string;
}

/**
 * Payload dispatched via the `band:terminal-insert` window CustomEvent by the
 * shared dockview layout after it has surfaced the active workspace's terminal.
 * Carries the resolved `workspaceId` so each mounted `TerminalPanel` (one per
 * terminal session × one per cached workspace) only reacts when the delivery
 * targets its own workspace — preventing a reference from leaking into a cached
 * background workspace's terminal.
 */
export interface TerminalInsertDetail {
  /**
   * The file reference to type into the terminal, carried through verbatim from
   * {@link AddToTerminalDetail.reference} (already includes the dispatcher's
   * trailing space, e.g. `"src/foo.ts:10-20 "`).
   */
  reference: string;
  /** The workspace whose terminal should receive the reference. */
  workspaceId: string;
  /**
   * The specific terminal that should receive the reference — the workspace's
   * last-focused terminal, resolved by `SharedDockviewLayout` from the server's
   * panel-focus record. When absent (no focus recorded yet), each mounted
   * `TerminalPanel` falls back to accepting the reference if it's the currently
   * *visible* terminal, preserving the pre-focus-tracking behavior.
   */
  terminalId?: string;
}

/**
 * Payload dispatched via the `band:chat-insert` window CustomEvent by
 * `SharedDockviewLayout` after it has resolved the workspace's last-focused
 * chat and surfaced the Chat panel. The chat mirror of
 * {@link TerminalInsertDetail}: each mounted `PromptInput` (one per chat pane ×
 * one per cached workspace) only appends the reference when the delivery
 * targets its own workspace AND its own chat, so a reference never leaks into
 * a sibling pane or a cached background workspace.
 */
export type ChatInsertDetail = ChatInsertTarget &
  (
    | {
        /** The workspace-relative file path shown in the reference. */
        filePath: string;
        /** 1-based start line of the selection. */
        startLine: number;
        /** 1-based end line of the selection. */
        endLine: number;
      }
    | TextToChatDetail
  );

/** Which chat a {@link ChatInsertDetail} is for. */
interface ChatInsertTarget {
  /** The workspace whose chat should receive the reference. */
  workspaceId: string;
  /**
   * The specific chat pane that should receive the reference — the workspace's
   * last-focused chat. When absent (no focus recorded yet), the currently
   * *visible* chat pane accepts it instead.
   */
  chatId?: string;
}

/**
 * Build a bare file reference for a line range, e.g. `src/foo.ts:10-20` (or
 * `src/foo.ts:10` when the range is a single line). Shared by the chat,
 * terminal, and copy actions so every option produces an identical reference.
 */
export function buildLineReference(filePath: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${filePath}:${startLine}` : `${filePath}:${startLine}-${endLine}`;
}

/** The file and line mapping a CodeMirror view's selection refers to. */
interface SelectionSource {
  filePath: string;
  lineNumberMap?: number[];
}

const selectionSourceFacet = Facet.define<SelectionSource, SelectionSource | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * Tag a CodeMirror view with the file its text belongs to, so the right-click
 * menu (`CodeSelectionContextMenu`) can turn its selection into a file
 * reference with {@link readSelectionReference}.
 *
 * @param filePath - The workspace-relative file path shown in the reference.
 * @param lineNumberMap - Optional 0-indexed array mapping document line numbers
 *   to actual file line numbers. Used by the diff view, whose document holds
 *   only the hunks, so its line 1 can be line 120 of the file.
 */
export function selectionReferenceExtension(filePath: string, lineNumberMap?: number[]): Extension {
  return selectionSourceFacet.of({ filePath, lineNumberMap });
}

/**
 * Resolve a view's main selection to a file reference, applying the view's
 * line-number map. Returns null when nothing is selected or the view was not
 * tagged with {@link selectionReferenceExtension}.
 */
export function readSelectionReference(view: EditorView): SelectionToChatDetail | null {
  const source = view.state.facet(selectionSourceFacet);
  const { from, to } = view.state.selection.main;
  if (!source || from === to) return null;

  const { filePath, lineNumberMap } = source;
  const mapLine = (docLine: number) =>
    lineNumberMap && docLine >= 1 && docLine <= lineNumberMap.length
      ? lineNumberMap[docLine - 1]
      : docLine;

  return {
    filePath,
    selectedText: view.state.sliceDoc(from, to),
    startLine: mapLine(view.state.doc.lineAt(from).number),
    endLine: mapLine(view.state.doc.lineAt(to).number),
  };
}

/** "Add to Chat": hand the reference to the active workspace's chat. */
export function addSelectionToChat(detail: AddToChatDetail): void {
  window.dispatchEvent(new CustomEvent<AddToChatDetail>("band:add-to-chat", { detail }));
}

/** "Add to Terminal": type the reference into the active workspace's terminal. */
export function addSelectionToTerminal(detail: SelectionToChatDetail): void {
  // Trailing space mirrors the chat reference's typing ergonomics; no newline
  // so the terminal agent decides when to submit.
  const reference = `${buildLineReference(detail.filePath, detail.startLine, detail.endLine)} `;
  window.dispatchEvent(
    new CustomEvent<AddToTerminalDetail>("band:add-to-terminal", { detail: { reference } }),
  );
}

/** "Copy reference": put the bare `path:line` reference on the clipboard. */
export function copySelectionReference(detail: SelectionToChatDetail): Promise<boolean> {
  return writeClipboardText(buildLineReference(detail.filePath, detail.startLine, detail.endLine));
}
