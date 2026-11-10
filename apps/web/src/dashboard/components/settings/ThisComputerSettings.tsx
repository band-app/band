import { Button, Input } from "@band-app/ui";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { isDesktop } from "../../../lib/is-desktop";
import {
  pickFolder,
  type ThisComputerStatus,
  type useThisComputerWorker,
} from "../../../lib/this-computer-worker";
import { ErrorPopover } from "./ErrorPopover";

export type ThisComputer = ReturnType<typeof useThisComputerWorker>;

/** The worker id of this Mac when it is a worker of the hub the app is connected to, else null. */
export function thisComputerHostId(status: ThisComputerStatus | null): string | null {
  return status?.supported && status.installed && status.forThisHub ? status.hostId : null;
}

/**
 * The end of the Workers table in the desktop app. This Mac is a row of the table once it is a
 * worker, so this renders only what the table cannot: an "Add this Mac as a worker" row, the note
 * that a local hub already covers this computer, or the state of a worker that is installed but
 * not (yet) listed by this hub.
 */
export function ThisComputerRow({ computer }: { computer: ThisComputer }) {
  const { status, busy, error, note, run } = computer;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [roots, setRoots] = useState<string[]>([]);

  useEffect(() => {
    if (status && name === "") setName(status.defaultName);
  }, [status, name]);

  if (!isDesktop || !status?.supported) return null;

  const addFolder = async () => {
    const folder = await pickFolder().catch(() => null);
    if (folder && !roots.includes(folder)) setRoots([...roots, folder]);
  };

  const errorIcon = error ? (
    <ErrorPopover
      label="This computer action failed"
      testId="this-computer__error"
      message={error}
    />
  ) : null;

  let body: React.ReactNode = null;
  if (!status.remoteHub && !status.installed) {
    body = (
      <p className="text-sm text-muted-foreground" data-testid="this-computer__local-hub">
        This app runs its own hub, which already covers this computer.
      </p>
    );
  } else if (status.installed && !status.forThisHub) {
    body = (
      <div className="text-sm" data-testid="this-computer__state" data-status="other-hub">
        {status.name ?? "This computer"} is a worker of another hub
        {status.bundled ? "" : " (installed from npm)"}.
      </div>
    );
  } else if (!status.installed) {
    body = open ? (
      <div className="space-y-2">
        <Input
          aria-label="Computer name"
          data-testid="this-computer__name"
          value={name}
          maxLength={100}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        {roots.map((root) => (
          <div key={root} className="font-mono text-xs">
            {root}
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void addFolder()}
          >
            Add folder
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="this-computer__add"
            disabled={busy || name.trim() === ""}
            onClick={() => void run("worker_add", { name, roots })}
          >
            {busy ? "Setting up…" : "Add this computer"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {errorIcon}
        </div>
      </div>
    ) : (
      <button
        type="button"
        data-testid="this-computer__open"
        className="flex w-full items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4" />
        Add this Mac as a worker
        {errorIcon}
      </button>
    );
  }
  if (!body && !note) return null;
  return (
    <div
      data-testid="this-computer"
      className="mt-2 rounded-md border border-dashed border-border px-3 py-2.5"
    >
      {body}
      {note ? <p className="mt-2 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/**
 * The "This computer" section of the drawer of the worker that is this Mac: Remove, and for a
 * worker service installed from npm, Switch to the one bundled in the app.
 */
export function ThisComputerDrawerSection({ computer }: { computer: ThisComputer }) {
  const { status, busy, error, run } = computer;
  if (!status) return null;
  return (
    <div className="space-y-2 text-xs" data-testid="this-computer-section">
      <p className="text-muted-foreground">
        {status.bundled
          ? `Runs the worker bundled in this app (${status.version}), so an app update updates it.`
          : "Installed from npm."}
      </p>
      {status.roots.length > 0 ? (
        <p className="text-muted-foreground">Folders: {status.roots.join(", ")}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {!status.bundled ? (
          <Button
            type="button"
            size="sm"
            data-testid="this-computer__switch"
            disabled={busy}
            onClick={() => void run("worker_switch_bundled")}
          >
            Switch to the worker in this app
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="this-computer__remove"
          disabled={busy}
          onClick={() => void run("worker_remove")}
        >
          {busy ? "Working…" : "Remove this computer"}
        </Button>
        {error ? (
          <ErrorPopover
            label="This computer action failed"
            testId="this-computer__error"
            message={error}
          />
        ) : null}
      </div>
    </div>
  );
}
