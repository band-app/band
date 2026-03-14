import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/workspace/$workspaceId/code")({
  component: () => <Outlet />,
});
