// Messages sent while the agent is still running. They render at the end of
// the transcript under a "Queued" divider, styled as user messages that
// haven't been sent yet, and go out in order when the turn ends.
import { cn } from "@band-app/ui";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Clock, CornerDownLeft, FileIcon, ImageIcon, Pencil, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { MessageResponse } from "../ai-elements/message";

export interface QueuedFilePart {
  mediaType: string;
  url: string;
  filename?: string;
}

export interface QueuedMessageView {
  id: string;
  text: string;
  files?: QueuedFilePart[];
}

export function QueuedMessages({
  messages,
  onDelete,
  onEdit,
  onReorder,
}: {
  messages: QueuedMessageView[];
  onDelete: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onReorder: (event: DragEndEvent) => void;
}) {
  // The bubble itself is the drag handle. A mouse drag starts after 4 px, so
  // a click (on a link, say) doesn't start one. On touch a drag needs a
  // long press, so a swipe over a bubble still scrolls the chat.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <section data-testid="chat-pane__queue" aria-label="Queued messages" className="flex flex-col">
      <div
        data-testid="chat-pane__queue-divider"
        className="mb-3 flex items-center gap-3 text-xs text-muted-foreground"
      >
        <div className="h-px flex-1 bg-border" />
        <span className="flex shrink-0 items-center gap-1.5">
          <Clock className="size-3.5" />
          Queued · sent when the agent finishes
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onReorder}>
        <SortableContext items={messages.map((m) => m.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-2">
            {messages.map((m) => (
              <QueuedMessage
                key={m.id}
                message={m}
                onDelete={() => onDelete(m.id)}
                onEdit={(text) => onEdit(m.id, text)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  );
}

function QueuedMessage({
  message,
  onDelete,
  onEdit,
}: {
  message: QueuedMessageView;
  onDelete: () => void;
  onEdit: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: message.id,
    disabled: editing,
  });

  // Reset the draft to the latest text when the editor opens, not on every
  // queue update, so an unrelated push doesn't clobber an edit in progress.
  const openEditor = useCallback(() => {
    setDraft(message.text);
    setEditing(true);
  }, [message.text]);

  const save = useCallback(() => {
    const next = draft.trim();
    if (!next) return;
    if (next !== message.text) onEdit(next);
    setEditing(false);
  }, [draft, message.text, onEdit]);

  return (
    <div
      ref={setNodeRef}
      data-testid="chat-pane__queued-message"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : undefined,
      }}
      className={cn(
        "group ml-auto flex min-w-0 flex-col items-end gap-1",
        editing ? "w-full max-w-[90%]" : "max-w-[90%]",
      )}
    >
      {editing ? (
        // The composer's box and textarea, so editing looks like typing a
        // new message. Moving focus out of the editor discards the edit, as
        // Escape does; switching to another window doesn't.
        <div
          data-testid="chat-pane__queued-editor"
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            if (!document.hasFocus()) return;
            setEditing(false);
          }}
          className="flex w-full min-w-0 items-end gap-1 rounded-lg border border-border bg-muted/50 p-1 shadow-sm transition-colors focus-within:border-foreground/30"
        >
          <textarea
            aria-label="Edit queued message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: the user just asked to edit this message
            autoFocus
            onFocus={(e) => e.currentTarget.setSelectionRange(draft.length, draft.length)}
            onKeyDown={(e) => {
              // Enter saves, Shift+Enter adds a line, like the composer.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                // Keep Escape from also stopping the running turn.
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              }
            }}
            className="block field-sizing-content max-h-48 min-h-[40px] w-full resize-none overflow-y-auto bg-transparent px-2 py-2 text-base text-foreground outline-none lg:min-h-[32px] lg:py-1.5 lg:text-sm"
          />
          {/* The composer's send button. Pressing it keeps focus in the
              textarea, so the editor's blur doesn't discard the edit first. */}
          <button
            type="button"
            aria-label="Save"
            onMouseDown={(e) => e.preventDefault()}
            onClick={save}
            disabled={!draft.trim()}
            className={cn(
              "inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors lg:size-7",
              draft.trim()
                ? "text-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
                : "text-muted-foreground",
            )}
          >
            <CornerDownLeft className="size-4 lg:size-3.5" />
          </button>
        </div>
      ) : (
        <>
          {/* The sent-message bubble's shape and type, outlined instead of
              filled so it reads as not sent yet. Dragging it reorders the
              queue. */}
          <div
            data-testid="chat-pane__queued-bubble"
            {...attributes}
            {...listeners}
            className="flex w-fit min-w-0 max-w-full cursor-grab select-none flex-col gap-2 break-words [overflow-wrap:anywhere] rounded-md border-2 border-border bg-transparent px-4 py-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing lg:text-sm"
          >
            {message.files && message.files.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {message.files.map((file) => (
                  <QueuedFileChip key={file.url} file={file} />
                ))}
              </div>
            )}
            {message.text.trim() && (
              <div data-testid="chat-pane__queued-text">
                <MessageResponse>{message.text}</MessageResponse>
              </div>
            )}
          </div>
          <div
            data-testid="chat-pane__queued-actions"
            className={cn(
              "flex items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity",
              "group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
              isDragging && "opacity-100",
            )}
          >
            <button
              type="button"
              aria-label="Edit queued message"
              onClick={openEditor}
              className="rounded p-1 hover:bg-accent hover:text-foreground"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Delete queued message"
              onClick={onDelete}
              className="rounded p-1 hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function QueuedFileChip({ file }: { file: QueuedFilePart }) {
  const Icon = file.mediaType.startsWith("image/") ? ImageIcon : FileIcon;
  return (
    <span
      data-testid="chat-pane__queued-attachment"
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{file.filename ?? "File"}</span>
    </span>
  );
}
