import { CaseSensitive, ChevronDown, ChevronUp, Regex, Search, WholeWord, X } from "lucide-react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchBarProps {
  /** Current search query text */
  query: string;
  /** Called when the query text changes */
  onQueryChange: (query: string) => void;
  /** Current search option toggles */
  options: SearchOptions;
  /** Called when any search option toggle changes */
  onOptionsChange: (options: SearchOptions) => void;
  /** Input placeholder text */
  placeholder?: string;
  /** Match info to display (e.g. "3 of 12") — omit to hide */
  matchInfo?: { total: number; current: number };
  /** Called when user requests next match (Enter / down arrow button) */
  onNext?: () => void;
  /** Called when user requests previous match (Shift+Enter / up arrow button) */
  onPrevious?: () => void;
  /** Called when user closes the search bar (Escape / X button) — omit to hide close button */
  onClose?: () => void;
  /** Extra class names for the root container */
  className?: string;
}

export interface SearchBarHandle {
  focus: () => void;
  select: () => void;
}

function ToggleButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex size-6 items-center justify-center rounded-sm transition-colors ${
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
      title={title}
    >
      {children}
    </button>
  );
}

export const SearchBar = forwardRef<SearchBarHandle, SearchBarProps>(function SearchBar(
  {
    query,
    onQueryChange,
    options,
    onOptionsChange,
    placeholder = "Find...",
    matchInfo,
    onNext,
    onPrevious,
    onClose,
    className,
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    select: () => inputRef.current?.select(),
  }));

  const toggleCase = useCallback(() => {
    onOptionsChange({ ...options, caseSensitive: !options.caseSensitive });
  }, [options, onOptionsChange]);

  const toggleWholeWord = useCallback(() => {
    onOptionsChange({ ...options, wholeWord: !options.wholeWord });
  }, [options, onOptionsChange]);

  const toggleRegex = useCallback(() => {
    onOptionsChange({ ...options, regex: !options.regex });
  }, [options, onOptionsChange]);

  return (
    <div
      className={`flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1.5 ${className ?? ""}`}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        placeholder={placeholder}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrevious?.();
            else onNext?.();
          }
          if (e.key === "Escape" && onClose) {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <ToggleButton active={options.caseSensitive} onClick={toggleCase} title="Match Case">
        <CaseSensitive className="size-4" />
      </ToggleButton>
      <ToggleButton active={options.wholeWord} onClick={toggleWholeWord} title="Match Whole Word">
        <WholeWord className="size-4" />
      </ToggleButton>
      <ToggleButton active={options.regex} onClick={toggleRegex} title="Use Regular Expression">
        <Regex className="size-4" />
      </ToggleButton>
      {matchInfo && query && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {matchInfo.total > 0 ? `${matchInfo.current} of ${matchInfo.total}` : "No results"}
        </span>
      )}
      {onPrevious && (
        <button
          type="button"
          onClick={onPrevious}
          disabled={!matchInfo || matchInfo.total === 0}
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
          title="Previous match (Shift+Enter)"
        >
          <ChevronUp className="size-3.5" />
        </button>
      )}
      {onNext && (
        <button
          type="button"
          onClick={onNext}
          disabled={!matchInfo || matchInfo.total === 0}
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
          title="Next match (Enter)"
        >
          <ChevronDown className="size-3.5" />
        </button>
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          title="Close (Escape)"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
});
