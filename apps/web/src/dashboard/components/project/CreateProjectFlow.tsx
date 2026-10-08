import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { AddRepoForm } from "../ProjectAddRepoDialog";
import { errorText, PROJECTS_KEY } from "./project-sections";

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const LOCAL_HOST_ID = "local";
type Step = "name" | "repos" | "host";
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "name", label: "Name" },
  { id: "repos", label: "Repos" },
  { id: "host", label: "Coordinator" },
];

/**
 * "New project" in three steps: the name and description (which creates the project and its
 * context repo), the first repos through the same form as Add repo, and the host the coordinator
 * runs on. Finishing starts the coordinator when the project has a repo and calls `onCreated`.
 */
export function CreateProjectFlow({
  open,
  onOpenChange,
  onCreated,
  onOpenHosts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string) => void;
  onOpenHosts?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]" data-testid="create-project">
        {open ? (
          <Flow
            onCreated={(id) => {
              onOpenChange(false);
              onCreated(id);
            }}
            onOpenHosts={
              onOpenHosts
                ? () => {
                    onOpenChange(false);
                    onOpenHosts();
                  }
                : undefined
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Flow({
  onCreated,
  onOpenHosts,
}: {
  onCreated: (projectId: string) => void;
  onOpenHosts?: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [adding, setAdding] = useState(true);
  const [hostId, setHostId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    enabled: step === "host",
  });
  const hostChoices = (hosts.data ?? []).filter(
    (h) => h.usable && (h.id === LOCAL_HOST_ID || h.status === "online"),
  );

  const trimmed = name.trim();
  const nameError =
    trimmed !== "" && !NAME.test(trimmed)
      ? "Use lowercase letters, digits, - and _, starting with a letter or digit."
      : null;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { project } = await trpc.projects.create.mutate({
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      setProjectId(project.id);
      setStep("repos");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      if (hostId) {
        await trpc.projects.update.mutate({ project: projectId, coordinatorHostId: hostId });
      }
      if (added.length > 0) {
        // Adding a registered repo may have started it already, and a second start is a no-op.
        await trpc.projects.startCoordinator.mutate({ project: projectId });
      }
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      onCreated(projectId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="create-project__flow" data-step={step}>
      <DialogHeader>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>
          A project groups the repos one body of work touches, with a coordinator agent that plans
          and dispatches tasks across them.
        </DialogDescription>
      </DialogHeader>
      <ol className="flex gap-2 text-xs" aria-label="Steps">
        {STEPS.map((s, i) => {
          const current = s.id === step;
          const done = STEPS.findIndex((x) => x.id === step) > i;
          return (
            <li
              key={s.id}
              aria-current={current ? "step" : undefined}
              className={`flex items-center gap-1.5 ${current ? "font-medium text-foreground" : "text-muted-foreground"}`}
            >
              <span
                className={`flex size-5 items-center justify-center rounded-full border text-[10px] ${
                  current || done ? "border-primary bg-primary text-primary-foreground" : ""
                }`}
              >
                {i + 1}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>

      {step === "name" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed && !nameError) void create();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="create-project-name">Name</Label>
            <Input
              id="create-project-name"
              data-testid="create-project__name"
              value={name}
              autoFocus
              placeholder="checkout-redesign"
              onChange={(e) => setName(e.target.value)}
            />
            <p
              className={`text-xs ${nameError ? "text-destructive" : "text-muted-foreground"}`}
              data-testid="create-project__name-hint"
            >
              {nameError ?? "Also the name of its context repo. You can set a display title later."}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="create-project-description">Description (optional)</Label>
            <Textarea
              id="create-project-description"
              data-testid="create-project__description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={busy || trimmed === "" || nameError !== null}
              data-testid="create-project__create"
            >
              {busy ? "Creating…" : "Create and add repos"}
            </Button>
          </div>
        </form>
      ) : null}

      {step === "repos" && projectId ? (
        <div className="space-y-3">
          {added.length > 0 ? (
            <ul className="space-y-1" data-testid="create-project__added">
              {added.map((r) => (
                <li
                  key={r}
                  className="rounded-md border px-2 py-1 text-sm"
                  data-testid="create-project__added-repo"
                  data-repo={r}
                >
                  {r}
                </li>
              ))}
            </ul>
          ) : null}
          {adding ? (
            <AddRepoForm
              projectId={projectId}
              onOpenHosts={onOpenHosts}
              onAdded={(repo) => {
                setAdded((list) => [...list, repo]);
                setAdding(false);
              }}
            />
          ) : (
            <Button
              size="sm"
              variant="outline"
              data-testid="create-project__add-another"
              onClick={() => setAdding(true)}
            >
              Add another repo
            </Button>
          )}
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button
              size="sm"
              variant={added.length > 0 ? "default" : "ghost"}
              data-testid="create-project__repos-next"
              onClick={() => setStep("host")}
            >
              {added.length > 0 ? "Next" : "Skip for now"}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "host" ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="create-project-host">Coordinator host</Label>
            <select
              id="create-project-host"
              data-testid="create-project__host"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
            >
              <option value="">Hub default</option>
              {hostChoices.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {added.length > 0
                ? "The coordinator chat and the project folder run here. It starts when you finish."
                : "The coordinator starts once the project has a repo."}
            </p>
          </div>
          <div className="flex justify-end">
            <Button size="sm" disabled={busy} data-testid="create-project__finish" onClick={finish}>
              {busy ? "Starting…" : "Open project"}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive" data-testid="create-project__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
