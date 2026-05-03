import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "../utils";

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** Accessible label when `label` is non-textual (e.g. an icon-only segment). */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Visually hidden group label for assistive tech. */
  ariaLabel?: string;
  className?: string;
  size?: "sm" | "md";
}

/**
 * iOS-style segmented control. The active segment renders a darker pill;
 * inactive segments are flat and muted. Use for 2–4 mutually exclusive
 * options where the choices are short.
 *
 * Built on top of Radix UI's RadioGroup so we inherit the proper
 * radiogroup/radio ARIA roles, keyboard navigation (arrow keys), and
 * roving tabindex without rolling our own focus management.
 */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  size = "md",
}: SegmentedControlProps<T>) {
  const sizeClasses = size === "sm" ? "gap-0.5 p-0.5 text-xs" : "gap-0.5 p-0.5 text-xs sm:text-sm";
  const segmentSizeClasses = size === "sm" ? "h-6 px-2" : "h-7 px-2.5";

  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={(v) => onChange(v as T)}
      aria-label={ariaLabel}
      orientation="horizontal"
      data-slot="segmented-control"
      className={cn("inline-flex items-center rounded-md", sizeClasses, className)}
    >
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <RadioGroupPrimitive.Item
            key={opt.value}
            value={opt.value}
            disabled={opt.disabled}
            aria-label={opt.ariaLabel}
            data-slot="segmented-control-item"
            className={cn(
              "inline-flex shrink-0 items-center justify-center gap-1 rounded-md font-medium",
              "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-50",
              segmentSizeClasses,
              isActive
                ? "bg-secondary text-foreground shadow-xs"
                : "bg-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.icon ? (
              <span className="inline-flex shrink-0 items-center [&_svg]:size-3.5">{opt.icon}</span>
            ) : null}
            <span className="truncate">{opt.label}</span>
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}

export { SegmentedControl };
