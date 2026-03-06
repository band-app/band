import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  branchName: string;
  isUnmerged: boolean;
  isDirty: boolean;
  hasUnpushedCommits: boolean;
}

export function DeleteWorkspaceDialog({
  open,
  onOpenChange,
  onConfirm,
  branchName,
  isUnmerged,
  isDirty,
  hasUnpushedCommits,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Delete workspace</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>{branchName}</strong>?
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          {isUnmerged && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
              <AlertTriangle className="size-4 shrink-0 text-yellow-500 mt-0.5" />
              <span>This branch has not been merged to main.</span>
            </div>
          )}
          {hasUnpushedCommits && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
              <AlertTriangle className="size-4 shrink-0 text-yellow-500 mt-0.5" />
              <span>This branch has unpushed commits that will be lost.</span>
            </div>
          )}
          {isDirty && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
              <AlertTriangle className="size-4 shrink-0 text-yellow-500 mt-0.5" />
              <span>There are uncommitted changes that will be lost.</span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
