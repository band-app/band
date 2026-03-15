import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// Lazy-load to avoid importing @xterm/xterm (CJS) in SSR context
const TerminalPanel = lazy(() =>
  import("../components/TerminalPanel").then((m) => ({
    default: m.TerminalPanel,
  })),
);

export const Route = createFileRoute("/workspace/$workspaceId/terminal")({
  component: WorkspaceTerminal,
});

function WorkspaceTerminal() {
  const { workspaceId } = Route.useParams();
  return (
    <Suspense fallback={null}>
      <TerminalPanel
        workspaceId={decodeURIComponent(workspaceId)}
        visible={true}
      />
    </Suspense>
  );
}
