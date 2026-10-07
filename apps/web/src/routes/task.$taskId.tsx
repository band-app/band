import { createFileRoute } from "@tanstack/react-router";

// The task view is drawn by `AppShell` (`TaskOverlay`), over the dockview layout that every other
// route leaves mounted. The route only owns the URL.
export const Route = createFileRoute("/task/$taskId")({
  component: () => null,
});
