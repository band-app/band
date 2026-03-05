import { createFileRoute } from "@tanstack/react-router";
import { DashboardView } from "../components/DashboardView";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-semibold">Band</h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <DashboardView />
      </main>
    </div>
  );
}
