import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
}

export function RestartTerminalDaemonDialog({ open, onOpenChange, onConfirm, busy }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-[425px]"
        onClick={(e) => e.stopPropagation()}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Restart the terminal service?</DialogTitle>
          <DialogDescription>
            Ends every terminal in Band's terminal service and starts a fresh one. Panes show that
            the process exited and can be reopened. Sessions from a previous version of Band are
            kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? "Restarting…" : "Restart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
