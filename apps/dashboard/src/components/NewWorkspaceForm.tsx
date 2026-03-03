import { useState } from "react";
import { useDashboardStore } from "@/stores/dashboard-store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface Props {
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewWorkspaceDialog({ projectName, open, onOpenChange }: Props) {
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const createWorkspace = useDashboardStore((s) => s.createWorkspace);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branch.trim()) return;
    await createWorkspace(projectName, branch.trim(), base.trim() || undefined);
    setBranch("");
    setBase("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add Workspace</DialogTitle>
            <DialogDescription>
              Create a new worktree branch for {projectName}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <Label htmlFor="branch-name">Branch name</Label>
            <Input
              id="branch-name"
              placeholder="feature/my-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              autoFocus
            />
            <Label htmlFor="base-branch">Base branch (optional)</Label>
            <Input
              id="base-branch"
              placeholder="main"
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
