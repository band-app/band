import { cn } from "@band-app/ui";
import { Command as CommandIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePromptInputContext } from "./prompt-input";

export interface SlashCommandSkill {
  name: string;
  description: string;
  argumentHint?: string;
}

interface SlashCommandSuggestionsProps {
  skills: SlashCommandSkill[];
}

/**
 * Find the slash-command token being typed. The command can appear anywhere
 * in the text — at the beginning or after a space.
 *
 * Returns `{ prefix, query }` where:
 *   - `prefix` is everything before the `/`
 *   - `query` is the partial command name (without the `/`)
 *
 * Returns `null` when no command is being typed (e.g. cursor past a space
 * after the command, or no `/` present).
 */
function getCommandContext(inputValue: string): { prefix: string; query: string } | null {
  // Find the last `/` that is at position 0 or preceded by whitespace
  for (let i = inputValue.length - 1; i >= 0; i--) {
    if (inputValue[i] === "/") {
      if (i === 0 || /\s/.test(inputValue[i - 1])) {
        const afterSlash = inputValue.slice(i + 1);
        // Still typing the command name — no spaces after the slash
        if (/\s/.test(afterSlash)) return null;
        return { prefix: inputValue.slice(0, i), query: afterSlash };
      }
    }
  }
  return null;
}

/**
 * Filter skills by fuzzy-matching against the partial command name.
 */
function filterSkills(skills: SlashCommandSkill[], query: string): SlashCommandSkill[] {
  if (!query) return skills;
  const lower = query.toLowerCase();
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(lower) || skill.description.toLowerCase().includes(lower),
  );
}

export function SlashCommandSuggestions({ skills }: SlashCommandSuggestionsProps) {
  const { inputValue, setTextareaValue, setCommandHint } = usePromptInputContext();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const ctx = skills.length > 0 ? getCommandContext(inputValue) : null;
  const isOpen = ctx !== null;
  const query = ctx?.query ?? "";
  const filteredSkills = isOpen ? filterSkills(skills, query) : [];
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

  // Intercept keyboard events on the textarea for navigation
  useEffect(() => {
    if (!isOpen || !hasResults) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredSkills.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredSkills.length) % filteredSkills.length);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(filteredSkills[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setTextareaValue("");
        setCommandHint(null);
      } else if (e.key === "Tab") {
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
                ? "bg-accent text-accent-foreground"
                : "text-popover-foreground hover:bg-accent/50",
            )}
            onMouseEnter={() => setSelectedIndex(index)}
            onMouseDown={(e) => {
              // Prevent textarea blur
              e.preventDefault();
              handleSelect(skill);
            }}
          >
            <CommandIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">/{skill.name}</span>
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
