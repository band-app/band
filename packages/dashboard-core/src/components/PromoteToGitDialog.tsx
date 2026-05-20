import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { GitBranch } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  projectName: string;
}

/**
 * Confirmation dialog for `projects.promoteToGit`. The action runs `git
 * init` in the project folder, which (while technically reversible by
 * deleting `.git` manually) is enough of a state change that we want the
 * user to opt in deliberately — mirrors the pattern used by
 * `DeleteWorkspaceDialog` for similarly side-effecting actions.
 */
export function PromoteToGitDialog({ open, onOpenChange, onConfirm, projectName }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Promote to git</DialogTitle>
          <DialogDescription>
            This will run <code>git init -b main</code> in <strong>{projectName}</strong> and turn
            it into a git repository.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
            <GitBranch className="size-4 shrink-0 text-blue-500 mt-0.5" />
            <span>
              After promotion you'll be able to create branches, view diffs, and use git pull / push
              for this project. The existing workspace stays in place.
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Promote to git</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
