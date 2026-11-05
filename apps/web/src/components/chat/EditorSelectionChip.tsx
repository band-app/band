import { X } from "lucide-react";
import { type EditorSelectionState, selectionChipLabel } from "../../lib/editor-selection";

/**
 * What the person selected in an open editor tab. It goes with the next message as a text block;
 * the X drops it for that message only.
 */
export function EditorSelectionChip({
  state,
  onRemove,
}: {
  state: EditorSelectionState;
  onRemove: () => void;
}) {
  const label = selectionChipLabel(state);
  return (
    <div className="flex px-2 pt-2" data-testid="chat__selection-chip">
      <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-selection px-2 py-0.5 text-xs text-foreground">
        <span className="min-w-0 truncate" title={state.selection.text ?? label}>
          {label}
        </span>
        <button
          type="button"
          aria-label="Remove selection from message"
          data-testid="chat__selection-chip-remove"
          className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
          onClick={onRemove}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
