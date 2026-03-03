import { useState } from "react";
import { useDashboardStore } from "../stores/dashboard-store";

interface Props {
  projectName: string;
  onClose: () => void;
}

export function NewWorkspaceForm({ projectName, onClose }: Props) {
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const createWorkspace = useDashboardStore((s) => s.createWorkspace);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branch.trim()) return;
    await createWorkspace(projectName, branch.trim(), base.trim() || undefined);
    onClose();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 px-4 py-2"
    >
      <input
        type="text"
        placeholder="branch name"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        className="flex-1 px-2 py-1 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
        autoFocus
      />
      <input
        type="text"
        placeholder="base (optional)"
        value={base}
        onChange={(e) => setBase(e.target.value)}
        className="w-32 px-2 py-1 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
      />
      <button
        type="submit"
        className="px-3 py-1 text-sm bg-[var(--color-accent)] text-white rounded hover:opacity-90 transition-opacity"
      >
        Create
      </button>
      <button
        type="button"
        onClick={onClose}
        className="px-2 py-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
      >
        Cancel
      </button>
    </form>
  );
}
