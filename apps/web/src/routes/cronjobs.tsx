import { createFileRoute } from "@tanstack/react-router";
import { CronjobsPageContent } from "../components/CronjobsPageContent";
import { isTauri } from "../lib/is-tauri";

export const Route = createFileRoute("/cronjobs")({
  component: CronjobsPage,
});

function CronjobsPage() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
      {isTauri && (
        <div data-tauri-drag-region className="h-[28px] shrink-0 flex items-center justify-center">
          <span className="text-xs font-medium text-muted-foreground select-none pointer-events-none">
            Cronjobs
          </span>
        </div>
      )}
      <CronjobsPageContent />
    </div>
  );
}
