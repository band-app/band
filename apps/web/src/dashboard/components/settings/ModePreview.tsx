// theme-lint-ignore-file: the mode cards are fixed miniatures of the light and dark themes
import { cn } from "@band-app/ui";
import type { ThemeMode } from "../../../lib/theme/model";

const LIGHT = { page: "#ffffff", side: "#f4f4f5", line: "#d4d4d8", accent: "#3b82f6" };
const DARK = { page: "#1e1e1e", side: "#2a2a2c", line: "#4a4a4f", accent: "#60a5fa" };

function Miniature({ palette }: { palette: typeof LIGHT }) {
  return (
    <div className="flex h-full w-full" style={{ background: palette.page }}>
      <div className="w-1/4" style={{ background: palette.side }} />
      <div className="flex flex-1 flex-col gap-1 p-1.5">
        <div className="h-1 w-3/4 rounded-full" style={{ background: palette.accent }} />
        <div className="h-1 w-full rounded-full" style={{ background: palette.line }} />
        <div className="h-1 w-2/3 rounded-full" style={{ background: palette.line }} />
        <div className="mt-auto h-2 rounded-full" style={{ background: palette.side }} />
      </div>
    </div>
  );
}

/** A small picture of what a mode looks like. System shows light and dark side by side. */
export function ModePreview({ mode, selected }: { mode: ThemeMode; selected: boolean }) {
  return (
    <div
      className={cn(
        "h-14 w-20 overflow-hidden rounded-lg border-2 transition-colors",
        selected ? "border-highlight" : "border-border",
      )}
    >
      {mode === "system" ? (
        <div className="flex h-full">
          <div className="w-1/2 overflow-hidden">
            <div className="h-full w-[160%]">
              <Miniature palette={LIGHT} />
            </div>
          </div>
          <div className="w-1/2 overflow-hidden">
            <div className="-ml-[60%] h-full w-[160%]">
              <Miniature palette={DARK} />
            </div>
          </div>
        </div>
      ) : (
        <Miniature palette={mode === "dark" ? DARK : LIGHT} />
      )}
    </div>
  );
}
