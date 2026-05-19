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
} from "@band-app/ui";
import { FolderOpen, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { useAdapter, useCapabilities } from "../context";
import { useAddProject } from "../hooks/use-project-mutations";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultLabel?: string | null;
}

export function AddProjectDialog({ open, onOpenChange, defaultLabel }: Props) {
  const [path, setPath] = useState("");
  // `null` means we haven't checked yet (or the path is empty). `true`/`false`
  // come from a debounced adapter.checkPath() call and drive the inline
  // "branch and PR features will be disabled" note. We probe on input change
  // instead of only on submit because the user benefits from knowing up-front
  // what they're signing up for — see #427's "show a one-line note" requirement.
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
  const addProjectMutation = useAddProject();
  const adapter = useAdapter();
  const capabilities = useCapabilities();

  const resetAndClose = () => {
    setPath("");
    setIsGitRepo(null);
    onOpenChange(false);
  };

  // Debounced existence/kind probe. 300 ms is long enough that someone
  // typing a deep path doesn't fire a checkPath() on every keystroke, but
  // short enough that the note appears before the user clicks submit.
  useEffect(() => {
    const trimmed = path.trim();
    if (!trimmed) {
      setIsGitRepo(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await adapter.checkPath(trimmed);
        if (!cancelled) setIsGitRepo(res.isGitRepo);
      } catch {
        // The path may not exist — leave the note hidden; add will surface
        // the real error.
        if (!cancelled) setIsGitRepo(null);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, adapter]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;

    const trimmedPath = path.trim();

    await addProjectMutation.mutateAsync({
      path: trimmedPath,
      label: defaultLabel ?? undefined,
    });
    resetAndClose();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setPath("");
      setIsGitRepo(null);
    }
    onOpenChange(open);
  };

  const handlePathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPath(e.target.value);
  };

  const handleBrowse = async () => {
    if (!capabilities.pickFolder) return;
    try {
      const selected = await capabilities.pickFolder();
      if (selected) {
        setPath(selected);
      }
    } catch {
      // Dialog cancelled
    }
  };

  const isBusy = addProjectMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Register Project</DialogTitle>
            <DialogDescription>
              Add a folder to manage its workspaces. Git repositories enable branches and PRs; plain
              folders work too, with a single implicit workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <Label htmlFor="project-path">Folder path</Label>
            <div className="flex gap-2">
              <Input
                id="project-path"
                placeholder="Path to folder (git repo or plain folder)"
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
            {isGitRepo === false && (
              <div className="flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm">
                <Info className="size-4 shrink-0 text-blue-500 mt-0.5" />
                <span>
                  This folder isn't a git repo. Branch and PR features will be disabled. You can
                  promote it to git later from the project context menu.
                </span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={resetAndClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isBusy}>
              Add Project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
