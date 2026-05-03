import { createFileRoute } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { DashboardView } from "../components/DashboardView";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isTauri } from "../lib/is-tauri";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  const isWideScreen = useIsDesktop();
  // Desktop split layout is active in Tauri or in a wide browser window.
  const isDesktop = isWideScreen || isTauri;

  // Desktop: sidebar is rendered by root layout, just show empty state
  if (isDesktop) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center px-8">
          <MessageSquare className="size-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Select a workspace to get started</p>
        </div>
      </div>
    );
  }

  // Mobile / narrow browser: full-screen dashboard shell
  return (
    <div className="h-dvh pb-4 standalone:pb-[env(safe-area-inset-bottom)]">
      <DashboardView />
    </div>
  );
}
