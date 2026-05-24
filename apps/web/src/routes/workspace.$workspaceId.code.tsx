import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";

export const Route = createFileRoute("/workspace/$workspaceId/code")({
  component: CodeLayout,
});

// Mobile-only layout. On desktop the shared dockview at AppShell renders the
// Files panel directly; this layout (and its `code.$` / `code.index` children)
// has nothing to render. See issue #467.
function CodeLayout() {
  const isWideScreen = useIsDesktop();
  const useDesktopLayout = isWideScreen || isDesktop;
  if (useDesktopLayout) return null;
  return <Outlet />;
}
