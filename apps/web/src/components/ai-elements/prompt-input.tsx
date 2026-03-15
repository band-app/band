import { Badge, cn } from "@band/ui";
import type { ChatStatus } from "ai";
import { ArrowUpIcon, Clock, FileIcon, Loader2, Paperclip, SquareIcon, X } from "lucide-react";
import type {
  ComponentProps,
  DragEvent,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
  ReactNode,
  RefObject,
} from "react";
import { createContext, useCallback, useContext, useRef, useState } from "react";

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
};

export const PromptInput = ({ className, onSubmit, children, ...props }: PromptInputProps) => {
  const formRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [hasText, setHasText] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [commandHint, setCommandHint] = useState<string | null>(null);

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
    },
    [onSubmit, fileEntries],
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

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    setHasText(value.trim().length > 0);
  }, []);

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

  return (
    <form
      className={cn(
        "relative flex w-full flex-col rounded-md border border-white/15 bg-white/5 p-2 shadow-[0_0_20px_rgba(255,255,255,0.06)]",
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
  onTextChange: (hasText: boolean) => void;
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
          "inline-flex size-8 lg:size-7 shrink-0 items-center justify-center rounded text-white/40 transition-colors hover:bg-muted hover:text-foreground",
          className,
        )}
        onClick={() => fileInputRef.current?.click()}
        {...props}
      >
        <Paperclip className="size-5 lg:size-4" />
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
};

/**
 * Build highlighted segments from the input text, colouring any
 * `/<command>` token blue. A command token is a `/` at position 0 or
 * preceded by whitespace, followed by word-chars / colons / dots / hyphens.
 */
function highlightSlashCommands(text: string): ReactNode[] {
  const segments: ReactNode[] = [];
  const regex = /(?:^|\s)(\/[\w:.+-]+)/g;
  let lastIndex = 0;
  let match = regex.exec(text);

  while (match !== null) {
    const commandStr = match[1]; // the /command part
    const commandStart = match.index + match[0].length - commandStr.length;

    // Plain text before the command
    if (commandStart > lastIndex) {
      segments.push(text.slice(lastIndex, commandStart));
    }

    // Command in blue
    segments.push(
      <span key={commandStart} className="text-blue-400">
        {commandStr}
      </span>,
    );
    lastIndex = commandStart + commandStr.length;
    match = regex.exec(text);
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    segments.push(text.slice(lastIndex));
  }

  return segments;
}

/**
 * Detect whether the ghost argument-hint should be shown.
 * The hint appears when a slash command token is followed by exactly one
 * trailing space with nothing typed after it — works for mid-text commands
 * too (e.g. "please /band:start ").
 */
function shouldShowGhostHint(inputValue: string, commandHint: string | null): boolean {
  if (!commandHint) return false;
  // Match a command token (at start or after space) followed by a single trailing space
  return /(?:^|\s)\/[\w:.+-]+ $/.test(inputValue);
}

export const PromptInputTextarea = ({
  className,
  placeholder = "Type a message...",
  onEscape,
  onPreviousMessage,
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false);
  const { onTextChange, textareaRef, setTextareaValue, commandHint, inputValue } =
    useContext(PromptInputContext);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) return;
        if (e.shiftKey) return;
        e.preventDefault();
        e.currentTarget.form?.requestSubmit();
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
    [isComposing, onEscape, onPreviousMessage, setTextareaValue],
  );

  const hasSlashCommand = inputValue.includes("/");
  const showGhostHint = shouldShowGhostHint(inputValue, commandHint);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          "min-h-[44px] lg:min-h-[36px] max-h-48 w-full resize-none bg-transparent px-2 py-2.5 lg:py-2 text-base lg:text-sm outline-none placeholder:text-white/40 field-sizing-content",
          hasSlashCommand && "text-transparent caret-foreground",
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
      {hasSlashCommand && (
        <div
          className="pointer-events-none absolute top-0 left-0 min-h-[44px] lg:min-h-[36px] w-full whitespace-pre-wrap break-words px-2 py-2.5 lg:py-2 text-base lg:text-sm text-foreground"
          aria-hidden
        >
          {highlightSlashCommands(inputValue)}
          {showGhostHint && <span className="text-muted-foreground/50">{commandHint}</span>}
        </div>
      )}
    </div>
  );
};

export type PromptInputSubmitProps = ComponentProps<"button"> & {
  status?: ChatStatus;
  onStop?: () => void;
  queueCount?: number;
};

export const PromptInputSubmit = ({
  className,
  status,
  onStop,
  queueCount,
  ...props
}: PromptInputSubmitProps) => {
  const { hasContent } = useContext(PromptInputContext);
  const isSubmitting = status === "submitted";
  const isStreaming = status === "streaming";
  const isBusy = isSubmitting || isStreaming;

  return (
    <div className="flex items-center gap-1">
      {queueCount != null && queueCount > 0 && (
        <Badge variant="secondary" className="text-xs tabular-nums">
          <Clock className="size-3" />
          {queueCount}
        </Badge>
      )}
      {isStreaming && (
        <button
          type="button"
          className="inline-flex size-8 lg:size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/80"
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
              : "bg-white/15 text-white/40",
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
