import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDashboardStore } from "@/stores/dashboard-store";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddProjectDialog({ open, onOpenChange }: Props) {
  const [path, setPath] = useState("");
  const addProject = useDashboardStore((s) => s.addProject);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    await addProject(path.trim());
    setPath("");
    onOpenChange(false);
  };

  const handleBrowse = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const selected = await invoke<string | null>("pick_folder");
      if (selected) setPath(selected);
    } catch {
      // Dialog cancelled or not in Tauri
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
                onChange={(e) => setPath(e.target.value)}
                autoFocus
              />
              <Button type="button" variant="outline" size="icon-xs" onClick={handleBrowse}>
                <FolderOpen />
              </Button>
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
