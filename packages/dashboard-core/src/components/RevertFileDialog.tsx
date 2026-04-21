import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { AlertTriangle } from "lucide-react";
import type { FileStatus } from "../types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  filename: string;
  fileStatus: FileStatus | undefined;
}

function statusDescription(status: FileStatus | undefined): string {
  switch (status) {
    case "A":
      return "This file was added and will be deleted.";
    case "U":
      return "This file is untracked and will be deleted.";
    case "D":
      return "This file was deleted and will be restored.";
    case "M":
      return "All changes to this file will be discarded.";
    case "R":
      return "This file was renamed and will be restored to its original path.";
    default:
      return "All changes to this file will be discarded.";
  }
}

export function RevertFileDialog({ open, onOpenChange, onConfirm, filename, fileStatus }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Revert file</DialogTitle>
          <DialogDescription>
            Are you sure you want to revert <strong className="break-all">{filename}</strong>?
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-yellow-500" />
            <span>{statusDescription(fileStatus)} This action cannot be undone.</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Revert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
