import { SettingsPage } from "@band-app/dashboard-core";
import { ScrollArea } from "@band-app/ui";
import { createFileRoute } from "@tanstack/react-router";
import { isTauri } from "../lib/is-tauri";

export const Route = createFileRoute("/settings")({
  component: SettingsRoute,
});

function SettingsRoute() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
      {isTauri && (
        <div data-tauri-drag-region className="h-[28px] shrink-0 flex items-center justify-center">
          <span className="text-xs font-medium text-muted-foreground select-none pointer-events-none">
            Settings
          </span>
        </div>
      )}
      <ScrollArea className="flex-1 overflow-hidden">
        <div className="px-2 py-2">
          <SettingsPage hideTitle />
        </div>
      </ScrollArea>
    </div>
  );
}
