import { cn } from "@band-app/ui";
import type { ChatStatus } from "ai";
import { ArrowUpIcon, FileIcon, Loader2, Paperclip, SquareIcon, X } from "lucide-react";
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
import type { SelectionToChatDetail } from "@/dashboard";

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
   *  event handlers so hidden workspaces' textareas aren't modified. */
  visible?: boolean;
  /** Whether the workspace is active (even if the chat tab isn't focused).
   *  Used to accept "Add to Chat" events from sibling panels (Changes, Files)
   *  when the Chat tab isn't in front. Falls back to `visible` if not set. */
  wsActive?: boolean;
};

function readDraft(key: string | null): string {
  if (!key) return "";
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export const PromptInput = ({
  className,
  onSubmit,
  draftKey,
  visible,
  wsActive,
  children,
  ...props
}: PromptInputProps) => {
  const formRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const draftStorageKey = draftKey ? `band-draft:${draftKey}` : null;
  const [hasText, setHasText] = useState(() => readDraft(draftStorageKey).length > 0);
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

  // Ref for gating global event handlers — hidden workspaces must not
  // process events that would modify their textarea.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // wsActive gates the "Add to Chat" handler: true when the workspace is active
  // even if the chat tab isn't the focused tab, so events from sibling panels
  // (Changes, Files) are still processed.
  const wsActiveRef = useRef(wsActive ?? visible);
  wsActiveRef.current = wsActive ?? visible;

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
      if (draftStorageKey) sessionStorage.removeItem(draftStorageKey);
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
          sessionStorage.setItem(draftStorageKey, value);
        } else {
          sessionStorage.removeItem(draftStorageKey);
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

  // Listen for "Add to Chat" events from CodeMirror editors.
  // Only process the event when this workspace is active — with workspace
  // show/hide, multiple PromptInput instances are mounted simultaneously
  // and we must not modify hidden workspaces' textareas.  We gate on
  // wsActive (not visible) so that events from sibling panels like
  // Changes or Files are still processed even when the Chat tab isn't focused.
  useEffect(() => {
    const handler = (e: Event) => {
      if (wsActiveRef.current === false) return;
      const { filePath, startLine, endLine } = (e as CustomEvent<SelectionToChatDetail>).detail;

      const lineRef =
        startLine === endLine ? `${filePath}:${startLine}` : `${filePath}:${startLine}-${endLine}`;

      const reference = `\`${lineRef}\` `;

      const textarea = textareaRef.current;
      const current = textarea?.value ?? "";
      const combined = current + reference;

      // Use native setter pattern to keep React in sync
      if (textarea) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        nativeSetter?.call(textarea, combined);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        // Defer focus so it happens after CodeMirror finishes its dispatch
        // (the mousedown handler collapses the selection which re-grabs focus)
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = combined.length;
        });
      }
    };

    window.addEventListener("band:add-to-chat", handler);
    return () => window.removeEventListener("band:add-to-chat", handler);
  }, []);

  return (
    <form
      className={cn(
        "relative flex w-full flex-col rounded-md border-2 border-white/20 bg-muted/50 p-2 shadow-sm",
        isDragging && "border-primary/50 bg-primary/5",
        className,
      )}
      onSubmit={handleSubmit}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
      ref={formRef}
      {...props}
    >
      {fileEntries.length > 0 && <PromptInputFiles entries={fileEntries} onRemove={removeFile} />}
      <PromptInputContext.Provider
        value={{
          addFiles,
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

// File preview chips
function PromptInputFiles({
  entries,
  onRemove,
}: {
  entries: FileEntry[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-2 px-1">
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

// Actions row (bottom bar with attach + send)
export type PromptInputActionsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputActions = ({ className, ...props }: PromptInputActionsProps) => (
  <div className={cn("flex w-full items-center justify-between", className)} {...props} />
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
        onClick={() => fileInputRef.current?.click()}
        {...props}
      >
        <Paperclip className="size-4" />
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
      } else if (e.key === "Tab" && e.shiftKey && onShiftTab) {
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

  // Listen for the workspace-level ⌃⌘I "focus Chat" event. Multiple
  // PromptInputTextarea instances may be mounted (one per chat session
  // across one or more workspaces) — only the visible one's
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
    <div className="relative">
      <textarea
        ref={textareaRef}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          "min-h-[44px] lg:min-h-[36px] max-h-48 w-full resize-none overflow-y-auto bg-transparent px-2 py-2.5 lg:py-2 text-base lg:text-sm outline-none placeholder:text-muted-foreground field-sizing-content",
          className,
        )}
        name="message"
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

export type PromptInputSubmitProps = ComponentProps<"button"> & {
  status?: ChatStatus;
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

  return (
    <div className="flex items-center gap-1">
      {isStreaming && (
        <button
          type="button"
          className="inline-flex size-8 lg:size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground transition-colors hover:bg-secondary/80"
          onClick={onStop}
        >
          <SquareIcon className="size-4 lg:size-3.5 fill-current" />
        </button>
      )}
      {isSubmitting && !hasContent ? (
        <button
          type="button"
          className={cn(
            "inline-flex size-8 lg:size-7 shrink-0 items-center justify-center rounded-full bg-foreground/50 text-background transition-colors",
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
          disabled={!hasContent}
          className={cn(
            "inline-flex size-8 lg:size-7 shrink-0 items-center justify-center rounded-full transition-colors",
            hasContent
              ? isBusy
                ? "bg-primary text-primary-foreground hover:bg-primary/80"
                : "bg-foreground text-background hover:bg-foreground/80"
              : "bg-muted text-muted-foreground",
            className,
          )}
          {...props}
        >
          <ArrowUpIcon className="size-5 lg:size-4" />
        </button>
      )}
    </div>
  );
};
