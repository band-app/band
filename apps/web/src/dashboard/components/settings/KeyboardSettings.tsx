import { Button, Input } from "@band-app/ui";
import { useEffect, useState } from "react";
import { isDesktop } from "../../../lib/is-desktop";
import {
  assignBinding,
  COMMAND_DEFS,
  type CommandDef,
  chordFromEvent,
  chordLabel,
  commandDef,
  effectiveChord,
  findConflicts,
  formatChord,
  isOverridden,
  resetAllBindings,
  resetBinding,
  setBinding,
  setShortcutCapture,
} from "../../../lib/shortcuts";
import { useShortcutOverrides } from "../../../lib/use-shortcuts";
import { SettingsSection } from "./SettingsSection";

interface Pending {
  commandId: string;
  chord: string;
  conflicts: CommandDef[];
}

/** Settings > Keyboard: every registry command with its chord, and the controls to change it. */
export function KeyboardSettings() {
  useShortcutOverrides();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  // While a row records, the next chord is the new binding. The listener is the first on the
  // window (capture) and `setShortcutCapture` keeps every command from firing meanwhile.
  useEffect(() => {
    if (!recording) return;
    setShortcutCapture(true);
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // a bare modifier
      const conflicts = findConflicts(chord, recording);
      if (conflicts.length === 0) {
        assignBinding(recording, chord);
        setPending(null);
      } else {
        setPending({ commandId: recording, chord, conflicts });
      }
      setRecording(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      setShortcutCapture(false);
    };
  }, [recording]);

  const needle = query.trim().toLowerCase();
  const defs = COMMAND_DEFS.filter((d) => isDesktop || !d.desktopOnly).filter(
    (d) =>
      !needle || d.label.toLowerCase().includes(needle) || d.group.toLowerCase().includes(needle),
  );
  const groups = [...new Set(defs.map((d) => d.group))];
  const pendingDef = pending ? commandDef(pending.commandId) : undefined;

  return (
    <div className="space-y-6" data-testid="keyboard-settings">
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search commands..."
          aria-label="Search commands"
          data-testid="keyboard-settings__search"
        />
        <Button
          variant="outline"
          size="sm"
          data-testid="keyboard-settings__reset-all"
          onClick={() => {
            setPending(null);
            resetAllBindings();
          }}
        >
          Reset all
        </Button>
      </div>

      {pending && pendingDef && (
        <div
          role="alert"
          className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
          data-testid="keyboard-settings__conflict"
        >
          <p>
            {formatChord(pending.chord)} is already used by{" "}
            {pending.conflicts.map((c) => c.label).join(", ")}. Assigning it to {pendingDef.label}{" "}
            removes it from there.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              data-testid="keyboard-settings__conflict-confirm"
              onClick={() => {
                assignBinding(pending.commandId, pending.chord);
                setPending(null);
              }}
            >
              Reassign
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="keyboard-settings__conflict-cancel"
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {groups.map((group) => (
        <SettingsSection key={group} title={group}>
          {defs
            .filter((d) => d.group === group)
            .map((d) => {
              const chord = effectiveChord(d.id);
              const native = isDesktop && d.nativeAccelerator;
              return (
                <div
                  key={d.id}
                  data-slot="settings-row"
                  data-testid={`keyboard-settings__row--${d.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm">{d.label}</div>
                    {d.contextMenu && (
                      <div className="text-xs text-muted-foreground">Right-click menu action</div>
                    )}
                    {native && (
                      <div className="text-xs text-muted-foreground">Set by the desktop menu</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className="min-w-16 text-right font-mono text-xs text-muted-foreground"
                      data-testid={`keyboard-settings__chord--${d.id}`}
                    >
                      {recording === d.id ? "Press keys…" : (chordLabel(d.id) ?? "none")}
                    </span>
                    {!native && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`keyboard-settings__change--${d.id}`}
                          onClick={() => {
                            setPending(null);
                            setRecording(recording === d.id ? null : d.id);
                          }}
                        >
                          {recording === d.id ? "Cancel" : "Change"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!chord}
                          data-testid={`keyboard-settings__clear--${d.id}`}
                          onClick={() => setBinding(d.id, null)}
                        >
                          Clear
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!isOverridden(d.id)}
                          data-testid={`keyboard-settings__reset--${d.id}`}
                          onClick={() => resetBinding(d.id)}
                        >
                          Reset
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
        </SettingsSection>
      ))}
    </div>
  );
}
