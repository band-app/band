import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { useCallback } from "react";
import { isDesktop } from "../../lib/is-desktop";
import { chordLabel, commandDef } from "../../lib/shortcuts";
import { useShortcutOverrides } from "../../lib/use-shortcuts";
import type { PaletteCommand } from "../lib/command-registry";

interface CommandPaletteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
}

export function CommandPaletteDialog({ open, onOpenChange, commands }: CommandPaletteDialogProps) {
  // Re-render when the user rebinds a chord.
  useShortcutOverrides();
  const handleSelect = useCallback(
    (cmd: PaletteCommand) => {
      onOpenChange(false);
      // Run the action after the dialog closes to avoid focus conflicts
      requestAnimationFrame(() => cmd.action());
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        variant="command-palette"
        className="overflow-hidden p-0 lg:max-w-[520px]"
        showCloseButton={false}
        data-testid="command-palette"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command Palette</DialogTitle>
          <DialogDescription>Search for a command to run</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search commands..." />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No commands found.</CommandEmpty>
            <CommandGroup>
              {commands.map((cmd) => {
                const def = commandDef(cmd.id);
                const label = def?.desktopOnly && !isDesktop ? undefined : chordLabel(cmd.id);
                return (
                  <CommandItem
                    key={cmd.id}
                    value={cmd.label}
                    onSelect={() => handleSelect(cmd)}
                    data-testid={`command-palette__item--${cmd.id}`}
                  >
                    <span className="text-sm">{cmd.label}</span>
                    {cmd.hint && (
                      <span
                        className="text-xs text-muted-foreground"
                        data-testid={`command-palette__hint--${cmd.id}`}
                      >
                        {cmd.hint}
                      </span>
                    )}
                    {label && (
                      <CommandShortcut data-testid={`command-palette__shortcut--${cmd.id}`}>
                        {label}
                      </CommandShortcut>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
