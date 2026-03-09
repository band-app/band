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
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { useCapabilities } from "../context";
import { useAddProject } from "../hooks/use-project-mutations";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultLabel?: string | null;
}

export function AddProjectDialog({ open, onOpenChange, defaultLabel }: Props) {
  const [path, setPath] = useState("");
  const addProjectMutation = useAddProject();
  const capabilities = useCapabilities();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    await addProjectMutation.mutateAsync({ path: path.trim(), label: defaultLabel ?? undefined });
    setPath("");
    onOpenChange(false);
  };

  const handleBrowse = async () => {
    if (!capabilities.pickFolder) return;
    try {
      const selected = await capabilities.pickFolder();
      if (selected) setPath(selected);
    } catch {
      // Dialog cancelled
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPath(e.target.value)}
                autoFocus
              />
              {capabilities.pickFolder && (
                <Button type="button" variant="ghost" size="icon" onClick={handleBrowse}>
                  <FolderOpen />
                </Button>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Add Project</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
