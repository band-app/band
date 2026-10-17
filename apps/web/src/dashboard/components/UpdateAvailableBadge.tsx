import { Button } from "@band-app/ui";
import { ArrowUpCircle } from "lucide-react";
import { useState } from "react";

import { useUpdateStatus } from "../hooks/use-update-status";
import { UpdatePanelDialog } from "./UpdatePanelDialog";

/**
 * Shown in the sidebar footer only while the hub knows of a release newer than its own. Clicking
 * it opens the update panel. With no newer release, or when the check cannot reach GitHub, there
 * is nothing to show, and nothing is reported as an error.
 */
export function UpdateAvailableBadge() {
  const status = useUpdateStatus();
  const [open, setOpen] = useState(false);
  if (!status.data?.updateAvailable) return null;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-primary"
        aria-label={`Update available, version ${status.data.latest}`}
        data-testid="repo-list__update-badge"
        onClick={() => setOpen(true)}
      >
        <ArrowUpCircle className="size-4" />
        <span>v{status.data.latest}</span>
      </Button>
      <UpdatePanelDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
