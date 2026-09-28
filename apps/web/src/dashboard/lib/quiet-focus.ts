import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Marks a focus the user didn't aim at a position, like a tab switch landing
 * in the editor. The markdown preview reveals the syntax under the cursor only
 * while it has focus, and a fresh preview's cursor sits at 0, often inside
 * frontmatter or a heading. After a quiet focus the preview stays fully
 * rendered until the cursor moves or the text changes.
 */
export const quietFocus = StateEffect.define<null>();

/** Focus a CodeMirror editor's content element as a quiet focus. */
export function focusEditorQuietly(content: HTMLElement): void {
  EditorView.findFromDOM(content)?.dispatch({ effects: quietFocus.of(null) });
  content.focus({ preventScroll: true });
}
