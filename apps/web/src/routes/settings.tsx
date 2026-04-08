import { SettingsPage } from "@band-app/dashboard-core";
import { ScrollArea } from "@band-app/ui";
import { createFileRoute } from "@tanstack/react-router";
import { TauriTitleBar } from "../components/TauriTitleBar";
import { isTauri } from "../lib/is-tauri";

export const Route = createFileRoute("/settings")({
  component: SettingsRoute,
});

function SettingsRoute() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
      {isTauri && <TauriTitleBar title="Settings" />}
      <ScrollArea className="flex-1 overflow-hidden">
        <div className="px-2 py-2">
          <SettingsPage hideTitle />
        </div>
      </ScrollArea>
    </div>
  );
}
