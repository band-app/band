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
import { formatShortcut, type PaletteCommand } from "../lib/command-registry";

interface CommandPaletteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
}

export function CommandPaletteDialog({ open, onOpenChange, commands }: CommandPaletteDialogProps) {
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
      <DialogContent className="overflow-hidden p-0 sm:max-w-[520px]" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Command Palette</DialogTitle>
          <DialogDescription>Search for a command to run</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search commands..." />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>No commands found.</CommandEmpty>
            <CommandGroup>
              {commands.map((cmd) => (
                <CommandItem key={cmd.id} value={cmd.label} onSelect={() => handleSelect(cmd)}>
                  <span className="text-sm">{cmd.label}</span>
                  <CommandShortcut>{formatShortcut(cmd.shortcut)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
