import { useState } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { WorkspaceCard } from "./WorkspaceCard";
import { NewWorkspaceForm } from "./NewWorkspaceForm";

export function ProjectList() {
  const projects = useDashboardStore((s) => s.projects);
  const statuses = useDashboardStore((s) => s.statuses);
  const removeProject = useDashboardStore((s) => s.removeProject);
  const [expandedForm, setExpandedForm] = useState<string | null>(null);

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-[var(--color-text-muted)]">
        <p className="text-lg mb-2">No projects registered</p>
        <p className="text-sm">
          Click "+ New" to register a git repository
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {projects.map((project) => (
        <div key={project.name}>
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="text-base font-semibold text-[var(--color-text)]">
              {project.name}
            </h2>
            <div className="flex items-center gap-2">
              <button
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                onClick={() =>
                  setExpandedForm(
                    expandedForm === project.name ? null : project.name
                  )
                }
              >
                + workspace
              </button>
              <button
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors"
                onClick={() => removeProject(project.name)}
                title="Remove project"
              >
                ×
              </button>
            </div>
          </div>

          {expandedForm === project.name && (
            <NewWorkspaceForm
              projectName={project.name}
              onClose={() => setExpandedForm(null)}
            />
          )}

          <div className="flex flex-col gap-1.5">
            {project.worktrees.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)] px-4 py-2">
                No workspaces yet
              </p>
            ) : (
              project.worktrees.map((wt) => {
                const wsId = `${project.name}-${wt.branch}`;
                return (
                  <WorkspaceCard
                    key={wt.branch}
                    worktree={wt}
                    projectName={project.name}
                    status={statuses.get(wsId)}
                  />
                );
              })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
