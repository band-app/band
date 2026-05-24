import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";

// Lazy-load to avoid importing @xterm/xterm (CJS) in SSR context
const DockviewTerminalContainer = lazy(() =>
  import("../components/DockviewTerminalContainer").then((m) => ({
    default: m.DockviewTerminalContainer,
  })),
);

export const Route = createFileRoute("/workspace/$workspaceId/terminal")({
  component: WorkspaceTerminal,
});

// Mobile-only route. On desktop the shared dockview renders the Terminal
// panel; this route has nothing to add. Early-returning `null` keeps the
// lazy chunk from triggering a (no-op) Suspense fallback on desktop. See
// issue #467.
function WorkspaceTerminal() {
  const { workspaceId } = Route.useParams();
  const isWideScreen = useIsDesktop();
  const useDesktopLayout = isWideScreen || isDesktop;
  if (useDesktopLayout) return null;
  return (
    <Suspense fallback={null}>
      <DockviewTerminalContainer workspaceId={decodeURIComponent(workspaceId)} visible={true} />
    </Suspense>
  );
}
