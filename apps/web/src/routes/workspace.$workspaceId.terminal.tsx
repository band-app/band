import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// Lazy-load to avoid importing @xterm/xterm (CJS) in SSR context
const DockviewTerminalContainer = lazy(() =>
  import("../components/DockviewTerminalContainer").then((m) => ({
    default: m.DockviewTerminalContainer,
  })),
);

export const Route = createFileRoute("/workspace/$workspaceId/terminal")({
  component: WorkspaceTerminal,
});

function WorkspaceTerminal() {
  const { workspaceId } = Route.useParams();
  return (
    <Suspense fallback={null}>
      <DockviewTerminalContainer
        workspaceId={decodeURIComponent(workspaceId)}
        visible={true}
      />
    </Suspense>
  );
}
