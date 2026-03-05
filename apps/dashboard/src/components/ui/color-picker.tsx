import type * as React from "react";

import { cn } from "@/lib/utils";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

const PRESET_COLORS = [
  "#000000",
  "#ffffff",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#6b7280",
  "#78716c",
];

interface ColorPickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  showHex?: boolean;
  className?: string;
}

function ColorPicker({ value, onChange, disabled, showHex = true, className }: ColorPickerProps) {
  const colorValue = typeof value === "string" ? value : "#000000";

  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 w-full h-9 px-3 py-1",
            "border border-input rounded-md text-sm",
            "hover:bg-accent hover:text-accent-foreground",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            disabled && "opacity-50 cursor-not-allowed",
            className,
          )}
        >
          <div
            className="w-5 h-5 rounded border border-border"
            style={{ backgroundColor: colorValue }}
          />
          {showHex && <span className="flex-1 text-left">{colorValue}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="space-y-3">
          <Input
            type="color"
            value={colorValue}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
            className="h-20 p-1 cursor-pointer"
          />
          <div className="grid grid-cols-6 gap-1.5">
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={cn(
                  "w-7 h-7 rounded border-2 transition-all",
                  colorValue === color
                    ? "border-primary scale-110"
                    : "border-transparent hover:border-border",
                )}
                style={{ backgroundColor: color }}
                onClick={() => onChange(color)}
              />
            ))}
          </div>
          {showHex && (
            <Input
              type="text"
              value={colorValue}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
              placeholder="#000000"
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { ColorPicker, PRESET_COLORS, type ColorPickerProps };
