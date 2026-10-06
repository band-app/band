import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { closeDesktopViewer, useDesktopViewerHost } from "../../lib/desktop-viewer";
import { trpc } from "../../lib/trpc-client";
import { DesktopViewer } from "./DesktopViewer";

/** The one desktop viewer, opened with `openDesktopViewer(hostId)`. */
export function DesktopViewerDialog() {
  const hostId = useDesktopViewerHost();
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    enabled: hostId !== null,
  });
  const hostName = hosts.data?.find((h) => h.id === hostId)?.name ?? hostId ?? "";
  return (
    <Dialog open={hostId !== null} onOpenChange={(open) => !open && closeDesktopViewer()}>
      <DialogContent
        data-testid="desktop-viewer__dialog"
        className="flex h-[85vh] w-[min(96vw,1400px)] max-w-none flex-col"
      >
        <DialogHeader>
          <DialogTitle>Desktop</DialogTitle>
          <DialogDescription>
            The virtual desktop of {hostName}. It starts view only.
          </DialogDescription>
        </DialogHeader>
        {hostId && (
          <div className="min-h-0 flex-1">
            <DesktopViewer hostId={hostId} hostName={hostName} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
