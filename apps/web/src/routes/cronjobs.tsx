import { createFileRoute } from "@tanstack/react-router";
import { CronjobsPageContent } from "../components/CronjobsPageContent";
import { TauriTitleBar } from "../components/TauriTitleBar";
import { isTauri } from "../lib/is-tauri";

export const Route = createFileRoute("/cronjobs")({
  component: CronjobsPage,
});

function CronjobsPage() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
      {isTauri && <TauriTitleBar title="Cronjobs" />}
      <CronjobsPageContent />
    </div>
  );
}
