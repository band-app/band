import { cn } from "@band-app/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { getFileIcon } from "@/dashboard";
import { trpc } from "../../lib/trpc-client";
import { usePromptInputContext } from "./prompt-input";

interface FileMentionSuggestionsProps {
  workspaceId: string;
}

/**
 * Find the @mention token being typed. The mention can appear anywhere
 * in the text — at the beginning or after a space.
 *
 * Returns `{ prefix, query }` where:
 *   - `prefix` is everything before the `@`
 *   - `query` is the partial file path (without the `@`)
 *
 * Returns `null` when no mention is being typed (e.g. cursor past a space
 * after the path, or no `@` present).
 */
function getMentionContext(inputValue: string): { prefix: string; query: string } | null {
  // Find the last `@` that is at position 0 or preceded by whitespace
  for (let i = inputValue.length - 1; i >= 0; i--) {
    if (inputValue[i] === "@") {
      if (i === 0 || /\s/.test(inputValue[i - 1])) {
        const afterAt = inputValue.slice(i + 1);
        // Still typing the path — no spaces after the @
        if (/\s/.test(afterAt)) return null;
        return { prefix: inputValue.slice(0, i), query: afterAt };
      }
    }
  }
  return null;
}

export function FileMentionSuggestions({ workspaceId }: FileMentionSuggestionsProps) {
  const { inputValue, setTextareaValue } = usePromptInputContext();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ctx = getMentionContext(inputValue);
  const isOpen = ctx !== null;
  const query = ctx?.query ?? "";

  // Fetch files when query changes (debounced)
  useEffect(() => {
    if (!isOpen) {
      setFiles([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const delay = query ? 150 : 0;
    debounceRef.current = setTimeout(() => {
      trpc.workspace.searchFiles
        .query({ workspaceId, query, limit: 15 })
        .then((result) => {
          if (!cancelled) {
            setFiles(result.files);
            setSelectedIndex(0);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, delay);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isOpen, query, workspaceId]);

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-mention-item]");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, isOpen]);

  const handleSelect = useCallback(
    (filePath: string) => {
      const current = getMentionContext(inputValue);
      const prefix = current?.prefix ?? "";
      setTextareaValue(`${prefix}@${filePath} `);
    },
    [inputValue, setTextareaValue],
  );

  // Intercept keyboard events on the textarea for navigation
  useEffect(() => {
    if (!isOpen || files.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % files.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + files.length) % files.length);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(files[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Remove the @ trigger to dismiss
        const current = getMentionContext(inputValue);
        if (current) {
          setTextareaValue(current.prefix);
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        handleSelect(files[selectedIndex]);
      }
    };

    // Use capture phase to intercept before the textarea's own handler
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, files, selectedIndex, handleSelect, setTextareaValue, inputValue]);

  if (!isOpen || (files.length === 0 && !loading)) return null;

  return (
    <div className="absolute right-0 bottom-full left-0 z-50 mb-1 px-0">
      <div
        ref={listRef}
        className="max-h-[280px] overflow-y-auto rounded-md border border-border/50 bg-popover p-1 shadow-md"
        role="listbox"
        aria-label="File mentions"
      >
        {loading && files.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">Searching...</div>
        ) : (
          files.map((filePath, index) => {
            const fileName = filePath.split("/").pop() || filePath;
            const Icon = getFileIcon(fileName);
            return (
              <button
                key={filePath}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                data-mention-item
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-left text-sm outline-none transition-colors",
                  index === selectedIndex
                    ? "bg-accent text-accent-foreground dark:bg-neutral-700"
                    : "text-popover-foreground hover:bg-accent/50 dark:hover:bg-neutral-700/50",
                )}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(e) => {
                  // Prevent textarea blur
                  e.preventDefault();
                  handleSelect(filePath);
                }}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="shrink-0 font-medium">{fileName}</span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{filePath}</span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
