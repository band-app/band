import { filterSkills, getCommandContext, type SlashCommandSkill } from "@band-app/client/composer";
import { cn } from "@band-app/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePromptInputContext } from "./prompt-input";

interface SlashCommandSuggestionsProps {
  skills: SlashCommandSkill[];
}

export function SlashCommandSuggestions({ skills }: SlashCommandSuggestionsProps) {
  const { inputValue, setTextareaValue, setCommandHint } = usePromptInputContext();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const ctx = skills.length > 0 ? getCommandContext(inputValue) : null;
  const isOpen = ctx !== null;
  const query = ctx?.query ?? "";
  const filteredSkills = useMemo(
    () => (isOpen ? filterSkills(skills, query) : []),
    [isOpen, skills, query],
  );
  const hasResults = filteredSkills.length > 0;

  // Reset selection when query changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the intentional trigger
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-slash-item]");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, isOpen]);

  const handleSelect = useCallback(
    (skill: SlashCommandSkill) => {
      const current = getCommandContext(inputValue);
      const prefix = current?.prefix ?? "";
      setTextareaValue(`${prefix}/${skill.name} `);
      setCommandHint(skill.argumentHint ?? null);
    },
    [inputValue, setTextareaValue, setCommandHint],
  );

  // Intercept keyboard events on the textarea for navigation.
  //
  // The listener is gated only on `isOpen` — NOT on `hasResults` — so
  // that Esc is swallowed even when the user has typed `/something`
  // that matches no skill (e.g. mid-typing before a longer command
  // name becomes valid). Otherwise Esc would fall through to the
  // chat-level handler that cancels the in-flight task. Mirrors the
  // same fix applied to `file-mention-suggestions.tsx`.
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" && hasResults) {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredSkills.length);
      } else if (e.key === "ArrowUp" && hasResults) {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredSkills.length) % filteredSkills.length);
      } else if (e.key === "Enter" && !e.shiftKey && hasResults) {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(filteredSkills[selectedIndex]);
      } else if (e.key === "Escape") {
        // Swallow Esc so it doesn't bubble to the chat-level handler that
        // cancels the in-flight task — the user just wants to close this
        // dropdown. Listener is registered in the capture phase, so
        // stopPropagation() here also keeps the event from reaching the
        // textarea's React onKeyDown.
        e.preventDefault();
        e.stopPropagation();
        setTextareaValue("");
        setCommandHint(null);
      } else if (e.key === "Tab" && hasResults) {
        e.preventDefault();
        handleSelect(filteredSkills[selectedIndex]);
      }
    };

    // Use capture phase to intercept before the textarea's own handler
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [
    isOpen,
    hasResults,
    filteredSkills,
    selectedIndex,
    handleSelect,
    setTextareaValue,
    setCommandHint,
  ]);

  if (!isOpen || !hasResults) return null;

  return (
    <div className="absolute right-0 bottom-full left-0 z-50 mb-1 px-0">
      <div
        ref={listRef}
        className="max-h-[280px] overflow-y-auto rounded-md border border-border/50 bg-popover p-1 shadow-md"
        role="listbox"
        aria-label="Slash commands"
      >
        {filteredSkills.map((skill, index) => (
          <button
            key={skill.name}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            data-slash-item
            className={cn(
              "flex w-full cursor-pointer items-start gap-3 rounded-sm px-3 py-2 text-left text-sm outline-none transition-colors",
              index === selectedIndex
                ? "bg-list-highlight text-list-highlight-foreground"
                : "text-popover-foreground hover:bg-list-highlight/50",
            )}
            onMouseEnter={() => setSelectedIndex(index)}
            onMouseDown={(e) => {
              // Prevent textarea blur
              e.preventDefault();
              handleSelect(skill);
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-medium" data-testid="slash-command-suggestions__name">
                  /{skill.name}
                </span>
                {skill.argumentHint && (
                  <span className="truncate text-xs text-muted-foreground">
                    {skill.argumentHint}
                  </span>
                )}
              </div>
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                {skill.description}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
