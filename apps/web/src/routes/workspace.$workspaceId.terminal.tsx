import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// Lazy-load to avoid importing @xterm/xterm (CJS) in SSR context
const SplitTerminalContainer = lazy(() =>
  import("../components/SplitTerminalContainer").then((m) => ({
    default: m.SplitTerminalContainer,
  })),
);

export const Route = createFileRoute("/workspace/$workspaceId/terminal")({
  component: WorkspaceTerminal,
});

function WorkspaceTerminal() {
  const { workspaceId } = Route.useParams();
  return (
    <Suspense fallback={null}>
      <SplitTerminalContainer workspaceId={decodeURIComponent(workspaceId)} visible={true} />
    </Suspense>
  );
}
