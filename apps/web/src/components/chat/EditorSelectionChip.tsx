import { Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { X } from "lucide-react";
import { useState } from "react";
import { type EditorSelectionState, selectionChipLabel } from "../../lib/editor-selection";

/**
 * What the person selected in an open editor tab. In the composer it goes with the next message
 * as a text block and the X drops it for that message only. In a sent message it is read-only:
 * hover or tap shows the selected text.
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

/** The chip inside a sent message: no remove button, the selected text on hover or tap. */
export function SentSelectionChip({ label, text }: { label: string; text?: string }) {
  const [open, setOpen] = useState(false);
  const chip = (
    <span className="inline-flex max-w-full items-center rounded-md bg-selection px-2 py-0.5 text-xs text-foreground">
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
  if (!text) {
    return (
      <div className="mt-1 flex" data-testid="chat__sent-selection-chip">
        {chip}
      </div>
    );
  }
  return (
    <div className="mt-1 flex" data-testid="chat__sent-selection-chip">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          asChild
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onClick={(event) => {
            // A tap opens it; the trigger's own toggle would close it again after a hover.
            event.preventDefault();
            setOpen(true);
          }}
        >
          <button type="button" className="max-w-full text-left" aria-label={label}>
            {chip}
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="max-h-60 max-w-sm overflow-auto whitespace-pre-wrap p-2 text-xs"
          data-testid="chat__sent-selection-text"
        >
          {text}
        </PopoverContent>
      </Popover>
    </div>
  );
}
