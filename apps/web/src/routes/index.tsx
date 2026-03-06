import { createFileRoute } from "@tanstack/react-router";
import { DashboardView } from "../components/DashboardView";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <div className="h-dvh pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <DashboardView />
    </div>
  );
}
