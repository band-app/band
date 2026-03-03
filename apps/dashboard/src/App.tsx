import { useEffect, useState } from "react";
import { ProjectList } from "./components/ProjectList";
import { useDashboardStore } from "./stores/dashboard-store";
import { useStatusWatcher } from "./hooks/use-status";
function AddProjectDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const addProject = useDashboardStore((s) => s.addProject);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    await addProject(path.trim());
    onClose();
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form
        onSubmit={handleSubmit}
        className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 w-[400px]"
      >
        <h3 className="text-base font-semibold mb-4">Register Project</h3>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            placeholder="Path to git repository"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="flex-1 px-3 py-2 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
            autoFocus
          />
          <button
            type="button"
            onClick={handleBrowse}
            className="px-3 py-2 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)] transition-colors"
          >
            Browse
          </button>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            Add Project
          </button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const loadProjects = useDashboardStore((s) => s.loadProjects);
  const error = useDashboardStore((s) => s.error);
  const [showAddDialog, setShowAddDialog] = useState(false);

  useStatusWatcher();

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
        <h1 className="text-lg font-bold tracking-tight">Band</h1>
        <button
          onClick={() => setShowAddDialog(true)}
          className="px-3 py-1.5 text-sm bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity"
        >
          + New
        </button>
      </header>

      {error && (
        <div className="mx-6 mt-4 px-4 py-2 bg-[var(--color-error)]/10 border border-[var(--color-error)]/30 rounded-lg text-sm text-[var(--color-error)]">
          {error}
        </div>
      )}

      <main className="flex-1 px-6 py-6">
        <ProjectList />
      </main>

      {showAddDialog && (
        <AddProjectDialog onClose={() => setShowAddDialog(false)} />
      )}
    </div>
  );
}
