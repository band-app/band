import { ContextMenuShortcut } from "@band-app/ui";
import { chordLabel } from "../../lib/shortcuts";
import { useShortcutOverrides } from "../../lib/use-shortcuts";

/** The current chord of a registry command, shown at the end of a context menu item. */
export function MenuChord({ commandId }: { commandId: string }) {
  useShortcutOverrides();
  const label = chordLabel(commandId);
  if (!label) return null;
  return (
    <ContextMenuShortcut data-testid={`menu-chord--${commandId}`}>{label}</ContextMenuShortcut>
  );
}
