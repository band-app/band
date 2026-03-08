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
  Textarea,
} from "@band/ui";
import { useState } from "react";
import { useDashboardStore } from "../stores/index";

interface Props {
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewWorkspaceDialog({ projectName, open, onOpenChange }: Props) {
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [prompt, setPrompt] = useState("");
  const createWorkspace = useDashboardStore((s) => s.createWorkspace);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branch.trim()) return;
    await createWorkspace(
      projectName,
      branch.trim(),
      base.trim() || undefined,
      prompt.trim() || undefined,
    );
    setBranch("");
    setBase("");
    setPrompt("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add Workspace</DialogTitle>
            <DialogDescription>Create a new worktree branch for {projectName}.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <Label htmlFor="branch-name">Branch name</Label>
            <Input
              id="branch-name"
              placeholder="feature/my-branch"
              value={branch}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBranch(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
            <Label htmlFor="base-branch">Base branch (optional)</Label>
            <Input
              id="base-branch"
              placeholder="main"
              value={base}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBase(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <Label htmlFor="initial-prompt">Initial prompt (optional)</Label>
            <Textarea
              id="initial-prompt"
              placeholder="Describe the task for the coding agent..."
              value={prompt}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPrompt(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
