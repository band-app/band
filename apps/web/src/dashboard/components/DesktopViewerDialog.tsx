import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { closeDesktopViewer, useDesktopViewerHost } from "../../lib/desktop-viewer";
import { trpc } from "../../lib/trpc-client";
import { DesktopViewer } from "./DesktopViewer";

/**
 * The one desktop viewer, opened with `openDesktopViewer(hostId)`. It is a large overlay rather
 * than a center tab, because the Hosts settings screen opens it too and a host's desktop belongs
 * to no worktree. The viewer draws its own header, so the dialog has no padding or title bar.
 */
export function DesktopViewerDialog() {
  const hostId = useDesktopViewerHost();
  const contentRef = useRef<HTMLDivElement>(null);
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    enabled: hostId !== null,
  });
  const hostName = hosts.data?.find((h) => h.id === hostId)?.name ?? hostId ?? "";
  return (
    <Dialog open={hostId !== null} onOpenChange={(open) => !open && closeDesktopViewer()}>
      <DialogContent
        ref={contentRef}
        data-testid="desktop-viewer__dialog"
        showCloseButton={false}
        className="flex h-[calc(94vh/var(--app-zoom,1))] w-[calc(96vw/var(--app-zoom,1))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        onEscapeKeyDown={(event) => {
          // Escape leaves fullscreen before it closes anything, and in control mode it is a key
          // for the remote desktop.
          if (document.fullscreenElement) {
            event.preventDefault();
            void document.exitFullscreen();
            return;
          }
          if (contentRef.current?.querySelector('[data-control="true"]')) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">Desktop of {hostName}</DialogTitle>
        <DialogDescription className="sr-only">
          The virtual desktop of {hostName}. It starts view only.
        </DialogDescription>
        {hostId && (
          <DesktopViewer hostId={hostId} hostName={hostName} onClose={closeDesktopViewer} />
        )}
      </DialogContent>
    </Dialog>
  );
}
