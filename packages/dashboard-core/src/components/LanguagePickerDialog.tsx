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
 * `onSelect` callback. The override persists for the lifetime of the
 * tab via `useTabState.setLanguage` — see the `language` field on
 * `TabFileState`.
 *
 * Mirrors the shape of `CommandPaletteDialog` and `QuickOpenDialog`:
 * one searchable `Command` over a flat list of `SUPPORTED_LANGUAGES`.
 */

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { Check } from "lucide-react";
import { useCallback } from "react";
import { SUPPORTED_LANGUAGES } from "../lib/language-map";

interface LanguagePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Currently-active language id, used to render the check mark. */
  currentLanguage: string;
  /** Called with the chosen language id when the user picks one. */
  onSelect: (languageId: string) => void;
}

export function LanguagePickerDialog({
  open,
  onOpenChange,
  currentLanguage,
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
      <DialogContent className="overflow-hidden p-0 sm:max-w-[480px]" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Select Language Mode</DialogTitle>
          <DialogDescription>Search for a language to syntax-highlight the file</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Select language mode…" autoFocus />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No languages found.</CommandEmpty>
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
