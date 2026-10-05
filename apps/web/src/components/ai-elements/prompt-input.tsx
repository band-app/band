import { cn } from "@band-app/ui";
import { CircleStop, CornerDownLeft, FileIcon, Loader2, Plus, X } from "lucide-react";
import type {
  ComponentProps,
  DragEvent,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
  RefObject,
} from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { buildLineReference, type ChatInsertDetail } from "@/dashboard";
import { clientStorage } from "../../lib/client-state";

let fileIdCounter = 0;

interface FileEntry {
  id: string;
  file: File;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ACCEPTED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  "text/yaml",
  "application/x-yaml",
].join(",");

export interface PromptInputMessage {
  text: string;
  files?: File[];
}

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void;
  /** When set, the unsent input text is persisted to sessionStorage under this key so it survives unmounts (e.g. tab switches). */
  draftKey?: string;
  /** Whether the prompt input is currently visible/active. Used to gate global
   *  event handlers so hidden worktrees' textareas aren't modified. */
  visible?: boolean;
  /** Whether the worktree is active (even if the chat tab isn't focused).
   *  Used to accept "Add to Chat" events from sibling panels (Changes, Files)
   *  when the Chat tab isn't in front. Falls back to `visible` if not set. */
  wsActive?: boolean;
  /** The worktree this chat pane belongs to. Used to scope `band:chat-insert`
   *  delivery so a reference never leaks into another worktree's chat. */
  worktreeId?: string;
  /** The chat pane this input belongs to. When a `band:chat-insert` names a
   *  specific `chatId` (the worktree's last-focused chat), only the matching
   *  input appends the reference — fixing the old behavior where every open
   *  chat pane received it. */
  chatId?: string;
};

/**
 * The draft is kept on the server with the other client state, so a message
 * started on the phone is there on the desktop. Drafts used to live in
 * sessionStorage; one found there moves over on first read.
 */
function readDraft(key: string | null): string {
  if (!key) return "";
  const draft = clientStorage.getItem(key);
  if (draft) return draft;
  try {
    const legacy = sessionStorage.getItem(key);
    if (legacy) {
      sessionStorage.removeItem(key);
      clientStorage.setItem(key, legacy);
      return legacy;
    }
  } catch {}
  return "";
}

export const PromptInput = ({
  className,
  onSubmit,
  draftKey,
  visible,
  wsActive,
  worktreeId,
  chatId,
  children,
  ...props
}: PromptInputProps) => {
  const formRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const draftStorageKey = draftKey ? `band-draft:${draftKey}` : null;
  const [hasText, setHasText] = useState(() => readDraft(draftStorageKey).trim().length > 0);
  const [inputValue, setInputValue] = useState(() => readDraft(draftStorageKey));
  const [commandHint, setCommandHint] = useState<string | null>(null);

  // Restore draft into the uncontrolled textarea on mount.
  // Always set the value — even when the draft is empty — to clear any
  // stale content the browser/WebView may have restored by field name.
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    const draft = readDraft(draftStorageKey);
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!draft && !textarea.value) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(textarea, draft);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    if (draft) {
      textarea.selectionStart = textarea.selectionEnd = draft.length;
    }
  }, [draftStorageKey]);

  // Focus the textarea when the component first mounts and is visible.
  // This ensures new chat tabs opened via keyboard shortcut (Cmd+T) get
  // focus in the input field automatically.
  const mountFocusedRef = useRef(false);
  useEffect(() => {
    if (mountFocusedRef.current || !visible) return;
    mountFocusedRef.current = true;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [visible]);

  // Ref for gating global event handlers — hidden worktrees must not
  // process events that would modify their textarea.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // wsActive gates the "Add to Chat" handler: true when the worktree is active
  // even if the chat tab isn't the focused tab, so events from sibling panels
  // (Changes, Files) are still processed.
  const wsActiveRef = useRef(wsActive ?? visible);
  wsActiveRef.current = wsActive ?? visible;
  // Mirror worktree/chat identity for the stable `band:chat-insert` handler
  // (registered once with `[]` deps) so it always matches against current props.
  const worktreeIdRef = useRef(worktreeId);
  worktreeIdRef.current = worktreeId;
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const valid = Array.from(newFiles).filter((f) => f.size <= MAX_FILE_SIZE);
    const entries = valid.map((file) => ({ id: `file-${++fileIdCounter}`, file }));
    setFileEntries((prev) => [...prev, ...entries]);
  }, []);

  const removeFile = useCallback((id: string) => {
    setFileEntries((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const text = (formData.get("message") as string) || "";
      if (!text.trim() && fileEntries.length === 0) return;
      event.currentTarget.reset();
      const files = fileEntries.map((e) => e.file);
      onSubmit({ text, files: files.length > 0 ? files : undefined }, event);
      setFileEntries([]);
      setHasText(false);
      setInputValue("");
      setCommandHint(null);
      if (draftStorageKey) clientStorage.removeItem(draftStorageKey);
    },
    [onSubmit, fileEntries, draftStorageKey],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const pastedFiles = Array.from(e.clipboardData.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((f): f is File => f != null);
      if (pastedFiles.length > 0) {
        addFiles(pastedFiles);
      }
    },
    [addFiles],
  );

  const handleInputChange = useCallback(
    (value: string) => {
      setInputValue(value);
      setHasText(value.trim().length > 0);
      if (draftStorageKey) {
        if (value) {
          clientStorage.setItem(draftStorageKey, value);
        } else {
          clientStorage.removeItem(draftStorageKey);
        }
      }
    },
    [draftStorageKey],
  );

  const setTextareaValue = useCallback((value: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Use native setter to trigger React's synthetic event system
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    // Move cursor to end
    textarea.selectionStart = textarea.selectionEnd = value.length;
  }, []);

  // Deliver an "Add to Chat" reference from the selection context menu.
  // SharedDockviewLayout owns the worktree-agnostic `band:add-to-chat` intent:
  // it resolves the active worktree's last-focused chat and re-dispatches the
  // scoped `band:chat-insert` handled here. Many PromptInput instances are
  // mounted at once (one per chat pane × one per cached worktree), so we only
  // append when the delivery targets this pane:
  //   - worktree must match (skip cached background worktrees), and
  //   - when the delivery names a chatId, it must be *this* chat; when it
  //     doesn't (no focus recorded yet), only the visible pane accepts.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ChatInsertDetail>).detail;
      if (!detail) return;
      if (worktreeIdRef.current && detail.worktreeId !== worktreeIdRef.current) return;
      if (detail.chatId) {
        if (detail.chatId !== chatIdRef.current) return;
      } else if (wsActiveRef.current === false || visibleRef.current === false) {
        return;
      }

      const textarea = textareaRef.current;
      const current = textarea?.value ?? "";

      let reference: string;
      if ("text" in detail) {
        // Terminal text has no file behind it, so it goes in as a fenced block
        // on its own lines. The fence is one backtick longer than any run in
        // the text, so a ``` line in agent output can't close it early.
        const lead = current === "" || current.endsWith("\n") ? "" : "\n";
        const longestRun = Math.max(0, ...(detail.text.match(/`+/g) ?? []).map((r) => r.length));
        const fence = "`".repeat(Math.max(3, longestRun + 1));
        reference = `${lead}${fence}\n${detail.text.replace(/\n+$/, "")}\n${fence}\n`;
      } else {
        // Wrap the shared bare reference in a markdown code span so the chat
        // renderer turns it into a clickable file link (see `rehypeFileLinkedCode`
        // in file-link-components.tsx — it only links paths inside inline `<code>`).
        // The terminal/copy actions intentionally use the bare form instead.
        // Trailing space keeps it separated from any text the user types next.
        reference = `\`${buildLineReference(detail.filePath, detail.startLine, detail.endLine)}\` `;
      }
      const combined = current + reference;

      // Use native setter pattern to keep React in sync
      if (textarea) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        nativeSetter?.call(textarea, combined);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        // Defer focus to the next frame so it lands after the selection
        // context menu has finished closing.
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = combined.length;
        });
      }
    };

    window.addEventListener("band:chat-insert", handler);
    return () => window.removeEventListener("band:chat-insert", handler);
  }, []);

  return (
    <form
      // Keeps iOS AutoFill from offering saved contacts / passwords above the
      // keyboard for the message field.
      autoComplete="off"
      data-testid="prompt-input__form"
      className={cn("relative flex w-full flex-col gap-1", className)}
      onSubmit={handleSubmit}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
      ref={formRef}
      {...props}
    >
      <PromptInputContext.Provider
        value={{
          addFiles,
          fileEntries,
          removeFile,
          isDragging,
          hasContent: hasText || fileEntries.length > 0,
          onTextChange: handleInputChange,
          inputValue,
          textareaRef,
          setTextareaValue,
          commandHint,
          setCommandHint,
        }}
      >
        {children}
      </PromptInputContext.Provider>
    </form>
  );
};

interface PromptInputContextValue {
  addFiles: (files: FileList | File[]) => void;
  fileEntries: FileEntry[];
  removeFile: (id: string) => void;
  isDragging: boolean;
  hasContent: boolean;
  onTextChange: (value: string) => void;
  inputValue: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setTextareaValue: (value: string) => void;
  commandHint: string | null;
  setCommandHint: (hint: string | null) => void;
}

const PromptInputContext = createContext<PromptInputContextValue>({
  addFiles: () => {},
  fileEntries: [],
  removeFile: () => {},
  isDragging: false,
  hasContent: false,
  onTextChange: () => {},
  inputValue: "",
  textareaRef: { current: null },
  setTextareaValue: () => {},
  commandHint: null,
  setCommandHint: () => {},
});

export function usePromptInputContext() {
  return useContext(PromptInputContext);
}

/**
 * The bordered field: attached files above a row holding the textarea and,
 * in its bottom-right corner, the send button. The settings row
 * (`PromptInputActions`) goes below it, outside the border.
 */
export const PromptInputBody = ({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) => {
  const { fileEntries, removeFile, isDragging } = useContext(PromptInputContext);
  return (
    <div
      data-testid="prompt-input__body"
      className={cn(
        "flex w-full flex-col rounded-lg border border-border bg-muted/50 p-1 shadow-sm transition-colors focus-within:border-foreground/30",
        isDragging && "border-primary/50 bg-primary/5",
        className,
      )}
      {...props}
    >
      {fileEntries.length > 0 && <PromptInputFiles entries={fileEntries} onRemove={removeFile} />}
      <div className="flex min-w-0 items-end gap-1">{children}</div>
    </div>
  );
};

// File preview chips
function PromptInputFiles({
  entries,
  onRemove,
}: {
  entries: FileEntry[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="mb-1 flex flex-wrap gap-2 px-1 pt-1">
      {entries.map((entry) => (
        <FilePreview key={entry.id} file={entry.file} onRemove={() => onRemove(entry.id)} />
      ))}
    </div>
  );
}

function FilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith("image/");

  return (
    <div className="group/file relative flex items-center gap-2 rounded-md border border-border/50 bg-muted/50 px-2 py-1.5">
      {isImage ? (
        <img
          src={URL.createObjectURL(file)}
          alt={file.name}
          className="size-8 rounded object-cover"
        />
      ) : (
        <FileIcon className="size-4 text-muted-foreground" />
      )}
      <div className="flex flex-col">
        <span className="max-w-[150px] truncate text-sm">{file.name}</span>
        {!isImage && (
          <span className="text-sm text-muted-foreground">{formatFileSize(file.size)}</span>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Settings row below the field (attach, mode, model, context)
export type PromptInputActionsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputActions = ({ className, ...props }: PromptInputActionsProps) => (
  <div
    className={cn("flex w-full min-w-0 items-center justify-between gap-1 px-0.5", className)}
    {...props}
  />
);

// Attach button
export type PromptInputAttachProps = ComponentProps<"button">;

export const PromptInputAttach = ({ className, ...props }: PromptInputAttachProps) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { addFiles } = useContext(PromptInputContext);

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        data-testid="prompt-input__file-input"
        multiple
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            addFiles(e.target.files);
            e.target.value = "";
          }
        }}
      />
      <button
        type="button"
        className={cn(
          // Match the icon-button shell used by SessionHistoryMenu / ModeMenu /
          // AgentModelMenu in the action row so all affordances line up.
          "inline-flex shrink-0 items-center justify-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          className,
        )}
        aria-label="Attach files"
        onClick={() => fileInputRef.current?.click()}
        {...props}
      >
        <Plus className="size-4" />
      </button>
    </>
  );
};

export type PromptInputTextareaProps = HTMLAttributes<HTMLTextAreaElement> & {
  placeholder?: string;
  disabled?: boolean;
  /** Called when Escape is pressed (e.g. to stop streaming). */
  onEscape?: () => void;
  /** Called when ArrowUp is pressed on an empty input. Return the previous message text to load it, or undefined to do nothing. */
  onPreviousMessage?: () => string | undefined;
  /** Called when Shift+Tab is pressed inside the textarea. When provided,
   *  the default focus-previous behaviour is suppressed. Used by the host
   *  to toggle Edit/Plan mode. */
  onShiftTab?: () => void;
};

export const PromptInputTextarea = ({
  className,
  placeholder = "Type a message...",
  onEscape,
  onPreviousMessage,
  onShiftTab,
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false);
  const { onTextChange, textareaRef, setTextareaValue, inputValue } =
    useContext(PromptInputContext);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) return;
        if (e.shiftKey) return;
        // On mobile/touch devices, Enter inserts a newline (no keyboard shortcut
        // for Shift+Enter). Users submit via the send button instead.
        const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
        if (isTouchDevice) return;
        e.preventDefault();
        e.currentTarget.form?.requestSubmit();
      } else if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.metaKey && onShiftTab) {
        // Ctrl+Shift+Tab is the previous-tab chord, not a mode toggle.
        // Suppress default focus-previous so the cursor stays in the
        // textarea — host uses this to toggle a contextual mode picker.
        e.preventDefault();
        onShiftTab();
      } else if (e.key === "Escape") {
        onEscape?.();
      } else if (e.key === "ArrowUp" && onPreviousMessage) {
        const textarea = e.currentTarget;
        if (textarea.value === "") {
          const prevText = onPreviousMessage();
          if (prevText) {
            e.preventDefault();
            setTextareaValue(prevText);
          }
        }
      }
    },
    [isComposing, onEscape, onPreviousMessage, onShiftTab, setTextareaValue],
  );

  // JS fallback for auto-resize when CSS field-sizing-content is not supported
  const MAX_HEIGHT = 192; // matches max-h-48 (48 * 4px)
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputValue triggers resize recalc via scrollHeight
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Check if field-sizing-content is natively supported
    if (CSS.supports?.("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [inputValue, textareaRef]);

  // Listen for the worktree-level ⌃⌘I "focus Chat" event. Multiple
  // PromptInputTextarea instances may be mounted (one per chat session
  // across one or more worktrees) — only the visible one's
  // offsetParent is non-null, so only that instance's focus() call has
  // any visible effect. The others are no-ops.
  useEffect(() => {
    const handler = () => {
      const el = textareaRef.current;
      if (el && el.offsetParent !== null) {
        el.focus({ preventScroll: true });
      }
    };
    window.addEventListener("band:focus-chat", handler);
    return () => window.removeEventListener("band:focus-chat", handler);
  }, [textareaRef]);

  return (
    <div className="relative min-w-0 flex-1">
      <textarea
        ref={textareaRef}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        // Turns off the inline word completions iOS 17+ types ahead of the
        // cursor; the attributes above don't cover them.
        writingsuggestions="false"
        className={cn(
          "block min-h-[40px] lg:min-h-[32px] max-h-48 w-full resize-none overflow-y-auto bg-transparent px-2 py-2 lg:py-1.5 text-base lg:text-sm outline-none placeholder:text-muted-foreground field-sizing-content",
          className,
        )}
        name="message"
        rows={1}
        onCompositionEnd={() => setIsComposing(false)}
        onCompositionStart={() => setIsComposing(true)}
        onInput={(e) => onTextChange(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        {...props}
      />
    </div>
  );
};

/** What the submit button shows: Stop while a turn runs and the input is
 *  empty, otherwise Send (which queues during a turn). */
export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export type PromptInputSubmitProps = ComponentProps<"button"> & {
  status?: PromptInputStatus;
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  status,
  onStop,
  ...props
}: PromptInputSubmitProps) => {
  const { hasContent } = useContext(PromptInputContext);
  const isSubmitting = status === "submitted";
  const isStreaming = status === "streaming";
  const isBusy = isSubmitting || isStreaming;

  // One button at a time. Typed text or an attachment always gets Send, even
  // while a turn runs (the server queues it); an empty input during a turn
  // gets Stop.
  return (
    <div className="flex shrink-0 items-center gap-1">
      {isStreaming && !hasContent ? (
        <button
          type="button"
          data-testid="prompt-input__stop-button"
          aria-label="Stop generation"
          className="inline-flex size-8 lg:size-7 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
          onClick={onStop}
        >
          <CircleStop className="size-4 lg:size-3.5" />
        </button>
      ) : isSubmitting && !hasContent ? (
        <button
          type="button"
          className={cn(
            "inline-flex size-8 lg:size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
            className,
          )}
          disabled
          {...props}
        >
          <Loader2 className="size-5 lg:size-4 animate-spin" />
        </button>
      ) : (
        <button
          type="submit"
          data-testid="prompt-input__submit-button"
          aria-label="Send message"
          disabled={!hasContent}
          className={cn(
            "inline-flex size-8 lg:size-7 shrink-0 items-center justify-center rounded-md transition-colors",
            hasContent
              ? cn(
                  "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
                  isBusy ? "text-primary" : "text-foreground",
                )
              : "text-muted-foreground",
            className,
          )}
          {...props}
        >
          <CornerDownLeft className="size-4 lg:size-3.5" />
        </button>
      )}
    </div>
  );
};
