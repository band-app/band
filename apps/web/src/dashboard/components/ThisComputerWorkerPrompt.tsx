import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@band-app/ui";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { invoke } from "../../lib/desktop-ipc";
import { pickFolder, useThisComputerWorker } from "../../lib/this-computer-worker";

/**
 * Right after the desktop app connects to a remote hub, offers to make this Mac a worker of it.
 * The app asks the hub for the token itself, so nothing secret passes through this page.
 * "Not now" is remembered per hub; Settings > Hosts keeps the same action.
 */
export function ThisComputerWorkerPrompt() {
  const { status, busy, error, run } = useThisComputerWorker();
  const [dismissed, setDismissed] = useState(false);
  const [name, setName] = useState("");
  const [roots, setRoots] = useState<string[]>([]);

  useEffect(() => {
    if (status && name === "") setName(status.defaultName);
  }, [status, name]);

  if (!status?.promptPending || dismissed) return null;

  const notNow = () => {
    setDismissed(true);
    void invoke("worker_dismiss_prompt").catch(() => {});
  };

  const addFolder = async () => {
    const folder = await pickFolder().catch(() => null);
    if (folder && !roots.includes(folder)) setRoots([...roots, folder]);
  };

  const yes = async () => {
    // A successful install changes the status, which closes the dialog.
    if (await run("worker_add", { name, roots })) setDismissed(true);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && notNow()}>
      <DialogContent data-testid="this-computer-prompt">
        <DialogHeader>
          <DialogTitle>Use this Mac as a worker?</DialogTitle>
          <DialogDescription>
            The hub can then run worktrees and agents on this computer. Band installs a background
            service that keeps running after you quit the app. You can remove it in Settings &gt;
            Hosts.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Computer name</span>
            <Input
              aria-label="Computer name"
              data-testid="this-computer-prompt__name"
              value={name}
              maxLength={100}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              Folders it may use. Add none now: choosing a repo later adds its folder.
            </span>
            <ul>
              {roots.map((root) => (
                <li key={root} className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs">{root}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={`Remove ${root}`}
                    disabled={busy}
                    onClick={() => setRoots(roots.filter((r) => r !== root))}
                  >
                    <X className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="this-computer-prompt__add-folder"
              disabled={busy}
              onClick={() => void addFolder()}
            >
              Add folder
            </Button>
          </div>
          {error ? (
            <p
              role="alert"
              data-testid="this-computer-prompt__error"
              className="text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="this-computer-prompt__not-now"
            disabled={busy}
            onClick={notNow}
          >
            Not now
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="this-computer-prompt__yes"
            disabled={busy || name.trim() === ""}
            onClick={() => void yes()}
          >
            {busy ? "Setting up…" : error ? "Retry" : "Yes, use this Mac"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
