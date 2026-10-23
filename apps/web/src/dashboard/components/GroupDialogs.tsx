import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@band-app/ui";
import { useEffect, useState } from "react";

/** Names a new group, or renames one. */
export function GroupNameDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  initialName = "",
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  initialName?: string;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);
  const trimmed = name.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[380px]"
        data-testid="group-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed) return;
            onSubmit(trimmed);
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>A worktree is in one group at a time.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            aria-label="Group name"
            data-testid="group-dialog__name"
            value={name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed} data-testid="group-dialog__submit">
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Confirms deleting a group. Its worktrees stay and become ungrouped. */
export function DeleteGroupDialog({
  open,
  onOpenChange,
  groupName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[425px]"
        data-testid="group-delete-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Delete group</DialogTitle>
          <DialogDescription>
            Delete <strong>{groupName}</strong>? Its worktrees stay, without a group.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="group-delete-dialog__confirm"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Asks whether the worktrees started from a moved worktree move with it. Yes is the default. */
export function MoveChildrenDialog({
  open,
  onOpenChange,
  worktreeName,
  groupName,
  childCount,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktreeName: string;
  groupName: string;
  childCount: number;
  onChoose: (withChildren: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[425px]"
        data-testid="group-move-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>
            Move its {childCount} {childCount === 1 ? "child" : "children"} too?
          </DialogTitle>
          <DialogDescription>
            Moving <strong>{worktreeName}</strong> to <strong>{groupName}</strong>. The worktrees
            started from it can follow.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            data-testid="group-move-dialog__only"
            onClick={() => {
              onChoose(false);
              onOpenChange(false);
            }}
          >
            Move only this one
          </Button>
          <Button
            autoFocus
            data-testid="group-move-dialog__with-children"
            onClick={() => {
              onChoose(true);
              onOpenChange(false);
            }}
          >
            Move with children
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Picks the repo for a new worktree started from a group header. */
export function PickRepoDialog({
  open,
  onOpenChange,
  groupName,
  repos,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  repos: string[];
  onPick: (repo: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[380px]"
        data-testid="group-pick-repo-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>New worktree in {groupName}</DialogTitle>
          <DialogDescription>Pick the repo to branch from.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {repos.map((name) => (
            <Button
              key={name}
              variant="ghost"
              className="justify-start"
              data-testid={`group-pick-repo__item--${name}`}
              onClick={() => {
                onPick(name);
                onOpenChange(false);
              }}
            >
              {name}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
