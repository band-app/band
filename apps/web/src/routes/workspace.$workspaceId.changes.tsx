import { DiffView } from "@band/dashboard-core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useDiffStatsContext } from "./workspace.$workspaceId";

export const Route = createFileRoute("/workspace/$workspaceId/changes")({
  component: ChangesTab,
});

function ChangesTab() {
  const { workspaceId } = Route.useParams();
  const decoded = decodeURIComponent(workspaceId);
  const navigate = useNavigate();
  const { setDiffStats } = useDiffStatsContext();

  const handleOpenFile = useCallback(
    (filename: string) => {
      navigate({
        to: "/workspace/$workspaceId/code/$",
        params: { workspaceId, _splat: filename },
      });
    },
    [workspaceId, navigate],
  );

  return (
    <DiffView
      workspaceId={decoded}
      active
      onStatsChange={setDiffStats}
      onOpenFile={handleOpenFile}
    />
  );
}
