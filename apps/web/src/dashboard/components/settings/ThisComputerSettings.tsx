import { Button, Input } from "@band-app/ui";
import { useEffect, useState } from "react";
import { isDesktop } from "../../../lib/is-desktop";
import { pickFolder, useThisComputerWorker } from "../../../lib/this-computer-worker";
import { SettingsRow } from "./SettingsRow";

/**
 * The "This computer" section of Settings > Hosts (desktop app only): whether this Mac is a
 * worker of the hub the app is connected to, with Add, Remove and, for a worker service that
 * was installed from npm, Switch to the one bundled in the app.
 */
export function ThisComputerSettings() {
  const { status, busy, error, note, run } = useThisComputerWorker();
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

  let body: React.ReactNode;
  if (!status.remoteHub && !status.installed) {
    body = (
      <p className="text-sm text-muted-foreground" data-testid="this-computer__local-hub">
        This app runs its own hub, which already covers this computer.
      </p>
    );
  } else if (status.installed) {
    const state = status.forThisHub ? (status.hostStatus ?? "unknown") : "connected to another hub";
    body = (
      <div className="space-y-2 text-sm">
        <div data-testid="this-computer__state" data-status={state}>
          {status.name ?? "This computer"}: {state}
          {status.bundled ? ` · worker ${status.version}` : " · installed from npm"}
        </div>
        {status.roots.length > 0 ? (
          <div className="text-xs text-muted-foreground">Folders: {status.roots.join(", ")}</div>
        ) : null}
        <div className="flex gap-2">
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
        </div>
      </div>
    );
  } else {
    body = (
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
        <div className="flex gap-2">
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
        </div>
      </div>
    );
  }

  return (
    <SettingsRow
      variant="stacked"
      label="This computer"
      description="Run worktrees and agents on this Mac from the hub the app is connected to. The service runs the worker bundled in this app, so an app update updates it."
    >
      <div data-testid="this-computer">
        {body}
        {note ? <p className="mt-2 text-xs text-muted-foreground">{note}</p> : null}
        {error ? (
          <p
            role="alert"
            data-testid="this-computer__error"
            className="mt-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
