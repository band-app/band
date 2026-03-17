import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@band/ui";
import { AlertTriangle, FolderOpen } from "lucide-react";
import { useState } from "react";
import { useAdapter, useCapabilities } from "../context";
import { useAddProject, useGitInit } from "../hooks/use-project-mutations";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultLabel?: string | null;
}

export function AddProjectDialog({ open, onOpenChange, defaultLabel }: Props) {
  const [path, setPath] = useState("");
  const [needsGitInit, setNeedsGitInit] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const addProjectMutation = useAddProject();
  const gitInitMutation = useGitInit();
  const adapter = useAdapter();
  const capabilities = useCapabilities();

  const resetAndClose = () => {
    setPath("");
    setNeedsGitInit(false);
    setIsChecking(false);
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;

    const trimmedPath = path.trim();

    if (needsGitInit) {
      await gitInitMutation.mutateAsync(trimmedPath);
      await addProjectMutation.mutateAsync({
        path: trimmedPath,
        label: defaultLabel ?? undefined,
      });
      resetAndClose();
      return;
    }

    setIsChecking(true);
    try {
      const { isGitRepo } = await adapter.checkPath(trimmedPath);
      if (!isGitRepo) {
        setNeedsGitInit(true);
        setIsChecking(false);
        return;
      }
    } catch {
      // If check fails, proceed anyway — add will fail with a clear error
    }
    setIsChecking(false);

    await addProjectMutation.mutateAsync({
      path: trimmedPath,
      label: defaultLabel ?? undefined,
    });
    resetAndClose();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setPath("");
      setNeedsGitInit(false);
      setIsChecking(false);
    }
    onOpenChange(open);
  };

  const handlePathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPath(e.target.value);
    setNeedsGitInit(false);
  };

  const handleBrowse = async () => {
    if (!capabilities.pickFolder) return;
    try {
      const selected = await capabilities.pickFolder();
      if (selected) {
        setPath(selected);
        setNeedsGitInit(false);
      }
    } catch {
      // Dialog cancelled
    }
  };

  const isBusy = isChecking || addProjectMutation.isPending || gitInitMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Register Project</DialogTitle>
            <DialogDescription>Add a git repository to manage its workspaces.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <Label htmlFor="project-path">Repository path</Label>
            <div className="flex gap-2">
              <Input
                id="project-path"
                placeholder="Path to git repository"
                value={path}
                onChange={handlePathChange}
                autoFocus
              />
              {capabilities.pickFolder && (
                <Button type="button" variant="ghost" size="icon" onClick={handleBrowse}>
                  <FolderOpen />
                </Button>
              )}
            </div>
            {needsGitInit && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm">
                <AlertTriangle className="size-4 shrink-0 text-yellow-500 mt-0.5" />
                <span>
                  This folder is not a git repository. Initialize it with{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">git init</code>
                  ?
                </span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={resetAndClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isBusy}>
              {needsGitInit ? "Initialize & Add" : "Add Project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
