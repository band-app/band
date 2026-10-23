import { Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { Check } from "lucide-react";
import { type ElementType, type ReactNode, useRef, useState } from "react";
import { GROUP_COLOR_PRESETS } from "../lib/group-colors";

const SWATCH = "flex size-8 items-center justify-center rounded-full text-white"; // theme-lint-ignore-line: the check sits on a fixed preset color

/**
 * The colors a group can take: the presets with a check on the current one, and a custom color.
 * The sidebar's group menu and Settings > Groups both show it. `testId` prefixes each swatch's
 * test id with its lowercase preset name.
 */
export function GroupColorPicker({
  color,
  onChange,
  testId,
  Swatch = "button",
  custom = true,
}: {
  color: string;
  onChange: (color: string) => void;
  testId: string;
  /** The element each swatch is. A menu passes its item type, so a pick closes the menu. */
  Swatch?: ElementType;
  /** Offer a custom color. Left out in a menu, which closes before the native picker answers. */
  custom?: boolean;
}) {
  const customRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex w-44 flex-col gap-2 p-1">
      <div className="grid grid-cols-4 gap-2">
        {GROUP_COLOR_PRESETS.map((preset) => (
          <Swatch
            key={preset.value}
            {...(Swatch === "button" ? { type: "button" } : {})}
            aria-label={preset.name}
            aria-pressed={color.toLowerCase() === preset.value}
            data-testid={`${testId}--${preset.name.toLowerCase()}`}
            onClick={() => onChange(preset.value)}
            className={SWATCH}
            style={{ backgroundColor: preset.value }}
          >
            {color.toLowerCase() === preset.value ? <Check className="size-4" /> : null}
          </Swatch>
        ))}
      </div>
      {custom ? (
        <>
          <button
            type="button"
            data-testid={`${testId}-custom-button`}
            onClick={() => customRef.current?.click()}
            className="rounded px-2 py-1 text-left text-xs text-foreground hover:bg-accent"
          >
            Custom colour…
          </button>
          <input
            ref={customRef}
            type="color"
            aria-label="Custom colour"
            data-testid={`${testId}-custom`}
            value={color}
            onChange={(e) => onChange(e.target.value)}
            className="sr-only"
            tabIndex={-1}
          />
        </>
      ) : null}
    </div>
  );
}

/** A colour dot that opens the shared picker in a popover. */
export function GroupColorPopover({
  color,
  onChange,
  label,
  testId,
  dotTestId,
  children,
}: {
  color: string;
  onChange: (color: string) => void;
  label: string;
  testId: string;
  dotTestId: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={dotTestId}
          className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-accent/50"
        >
          <span className="size-3 rounded-full" style={{ backgroundColor: color }} />
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <GroupColorPicker
          color={color}
          testId={testId}
          onChange={(next) => {
            onChange(next);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
