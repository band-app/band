import { cn } from "@band/ui";
import type { ChatStatus } from "ai";
import { ArrowUpIcon, FileIcon, Loader2, Paperclip, SquareIcon, X } from "lucide-react";
import type {
  ComponentProps,
  DragEvent,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
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
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [hasText, setHasText] = useState(false);

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

  return (
    <form
      className={cn(
        "flex w-full flex-col rounded-md border border-border/50 bg-card p-2",
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
          onTextChange: setHasText,
        }}
      >
        {children}
      </PromptInputContext.Provider>
    </form>
  );
};

const PromptInputContext = createContext<{
  addFiles: (files: FileList | File[]) => void;
  hasContent: boolean;
  onTextChange: (hasText: boolean) => void;
}>({
  addFiles: () => {},
  hasContent: false,
  onTextChange: () => {},
});

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
        <span className="max-w-[150px] truncate text-xs">{file.name}</span>
        {!isImage && (
          <span className="text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
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
          "inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
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
};

export const PromptInputTextarea = ({
  className,
  placeholder = "Type a message...",
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false);
  const { onTextChange } = useContext(PromptInputContext);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) return;
        if (e.shiftKey) return;
        e.preventDefault();
        e.currentTarget.form?.requestSubmit();
      }
    },
    [isComposing],
  );

  return (
    <textarea
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      className={cn(
        "min-h-[44px] max-h-48 w-full resize-none bg-transparent px-2 py-2.5 text-sm outline-none placeholder:text-muted-foreground field-sizing-content",
        className,
      )}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onInput={(e) => onTextChange(e.currentTarget.value.trim().length > 0)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
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

  if (isSubmitting) {
    return (
      <button
        type="button"
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/50 text-background transition-colors",
          className,
        )}
        disabled
        {...props}
      >
        <Loader2 className="size-4 animate-spin" />
      </button>
    );
  }

  if (isStreaming) {
    return (
      <button
        type="button"
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/80",
          className,
        )}
        onClick={onStop}
        {...props}
      >
        <SquareIcon className="size-3.5 fill-current" />
      </button>
    );
  }

  return (
    <button
      type="submit"
      disabled={!hasContent}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
        hasContent
          ? "bg-foreground text-background hover:bg-foreground/80"
          : "bg-muted text-muted-foreground",
        className,
      )}
      {...props}
    >
      <ArrowUpIcon className="size-4" />
    </button>
  );
};
