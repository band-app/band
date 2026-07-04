/**
 * Searchable picker for the editor's syntax-highlighting language mode.
 *
 * Surfaced two ways (see issue #434 acceptance criteria):
 *
 *   - Click the language indicator on the editor's tab footer / status bar.
 *   - Run "Change Language Mode…" from the command palette.
 *
 * Both paths open this dialog, the user picks a language, and the
 * selection propagates to the FileViewer through the parent's
 * `onSelect` callback. The override is persisted to `useTabState`
 * (localStorage-backed), and survives reloads — see the `language`
 * field on `TabFileState`.
 *
 * Mirrors the shape of `CommandPaletteDialog` and `QuickOpenDialog`:
 * one searchable `Command` over a flat list of `SUPPORTED_LANGUAGES`.
 *
 * "Auto Detect" is a special leading entry that clears the manual
 * override and reverts to file-extension auto-detection — the only
 * non-close-and-reopen way to undo a previous explicit choice. Passes
 * the sentinel `AUTO_DETECT_LANGUAGE_ID` via `onSelect` so the parent
 * can branch on it.
 */

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { Check, Wand2 } from "lucide-react";
import { useCallback } from "react";
import { SUPPORTED_LANGUAGES } from "../lib/language-map";

/**
 * Sentinel value passed to `onSelect` when the user picks "Auto
 * Detect" — tells the parent to clear any manual override and revert
 * to extension-based detection. Chosen to be impossible as a real
 * language id (no language uses double-underscore wrapping).
 */
export const AUTO_DETECT_LANGUAGE_ID = "__auto__";

interface LanguagePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Currently-active language id, used to render the check mark on
   * the matching row.
   */
  currentLanguage: string;
  /**
   * Whether the active language is the result of a manual override
   * (vs. extension auto-detection). Drives whether the "Auto Detect"
   * row shows the active check mark and whether it's even surfaced —
   * if no override is active, picking Auto Detect is a no-op.
   */
  hasOverride?: boolean;
  /**
   * Called with the chosen language id when the user picks one, or
   * with `AUTO_DETECT_LANGUAGE_ID` when they pick the "Auto Detect"
   * row to clear an existing override.
   */
  onSelect: (languageId: string) => void;
}

export function LanguagePickerDialog({
  open,
  onOpenChange,
  currentLanguage,
  hasOverride,
  onSelect,
}: LanguagePickerDialogProps) {
  const handleSelect = useCallback(
    (id: string) => {
      onOpenChange(false);
      // Run the action after the dialog closes to avoid focus conflicts
      // with the editor view we're about to refocus. Same pattern the
      // command palette uses.
      requestAnimationFrame(() => onSelect(id));
    },
    [onOpenChange, onSelect],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        variant="command-palette"
        className="overflow-hidden p-0 lg:max-w-[480px]"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Select Language Mode</DialogTitle>
          <DialogDescription>Search for a language to syntax-highlight the file</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Select language mode…" autoFocus />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No languages found.</CommandEmpty>
            {/* "Auto Detect" only shows up when a manual override is
                in effect — otherwise it's a no-op row and would just
                add visual noise. The check mark uses `hasOverride` as
                a stand-in for "currently in override mode," matching
                how VS Code surfaces the same affordance. */}
            {hasOverride && (
              <>
                <CommandGroup>
                  <CommandItem
                    value="Auto Detect"
                    onSelect={() => handleSelect(AUTO_DETECT_LANGUAGE_ID)}
                  >
                    <Wand2 className="size-3.5" />
                    <span className="flex-1 text-sm">Auto Detect</span>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            <CommandGroup>
              {SUPPORTED_LANGUAGES.map((lang) => (
                <CommandItem
                  key={lang.id}
                  value={`${lang.label} ${lang.id}`}
                  onSelect={() => handleSelect(lang.id)}
                >
                  <span className="flex-1 text-sm">{lang.label}</span>
                  {lang.id === currentLanguage && (
                    <Check className="size-3.5 text-muted-foreground" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
