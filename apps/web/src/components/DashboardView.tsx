import { DashboardShell } from "@/dashboard";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";
import { DesktopLayout } from "./DesktopLayout";
import { ToolbarActionBar, ToolbarOverflowProvider } from "./ToolbarButtons";

export function DashboardView() {
  const isWideScreen = useIsDesktop();
  const useDesktopLayout = isWideScreen || isDesktop;

  if (useDesktopLayout) {
    return (
      <ToolbarOverflowProvider>
        <DesktopLayout bottomActions={<ToolbarActionBar />} />
      </ToolbarOverflowProvider>
    );
  }

  return (
    <ToolbarOverflowProvider>
      <DashboardShell bottomActions={<ToolbarActionBar />} />
    </ToolbarOverflowProvider>
  );
}
