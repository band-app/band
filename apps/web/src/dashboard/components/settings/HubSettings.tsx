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
import { useEffect, useState } from "react";
import { invoke } from "../../../lib/desktop-ipc";
import { crossOriginHub } from "../../../lib/hub-config";
import { isDesktop } from "../../../lib/is-desktop";
import { ErrorPopover } from "./ErrorPopover";
import { HubUpdateCard } from "./HubUpdateCard";
import { SettingsRow } from "./SettingsRow";

interface HubChoiceView {
  mode: "local" | "remote";
  url: string;
  hasToken: boolean;
  /** The local hub runs as a service on this Mac. */
  localService?: boolean;
}

type SetResult = { ok: true } | { ok: false; error: string };

/**
 * Settings > Hub. A Connection card (read-only in the desktop app, with Change… opening the hub
 * picker in a dialog; in a browser it names the hub the page talks to) and an Updates card for an
 * admin. Applying a connection change reloads the window, so it is not part of the dialog's Save.
 */
export function HubSettings({ onOpenWorkers }: { onOpenWorkers?: () => void }) {
  return (
    <>
      {isDesktop ? <HubConnectionDesktop /> : <HubConnectionBrowser />}
      <SettingsRow
        variant="stacked"
        label="Updates"
        description="How the hub updates. A worker installs the hub's version once the hub runs it."
      >
        <HubUpdateCard onOpenWorkers={onOpenWorkers} />
      </SettingsRow>
    </>
  );
}

function HubConnectionBrowser() {
  const url = crossOriginHub()?.origin ?? window.location.origin;
  return (
    <SettingsRow variant="stacked" label="Connection" description="The hub this page talks to.">
      <div className="text-sm" data-testid="settings__hub-connection">
        <span className="text-muted-foreground">Hub </span>
        <span className="break-all font-mono text-xs" data-testid="settings__hub-connection-url">
          {url}
        </span>
      </div>
    </SettingsRow>
  );
}

function HubConnectionDesktop() {
  const [saved, setSaved] = useState<HubChoiceView | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<HubChoiceView>("hub_get_choice")
      .then((choice) => {
        if (!cancelled) setSaved(choice);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!saved) return null;
  return (
    <SettingsRow variant="stacked" label="Connection" description="The hub this app talks to.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5 text-sm" data-testid="settings__hub-connection">
          <div data-testid="settings__hub-connection-mode" data-mode={saved.mode}>
            {saved.mode === "local" ? "This Mac" : "Remote hub"}
          </div>
          {saved.mode === "remote" ? (
            <div
              className="break-all font-mono text-xs text-muted-foreground"
              data-testid="settings__hub-connection-url"
            >
              {saved.url}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {saved.localService ? "Runs as a background service." : "Runs with this app."}
            </div>
          )}
          {saved.mode === "remote" ? (
            <div
              className="text-xs text-muted-foreground"
              data-testid="settings__hub-connection-token"
            >
              {saved.hasToken ? "Token saved" : "No token saved"}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="settings__hub-change"
          onClick={() => setOpen(true)}
        >
          Change…
        </Button>
      </div>
      <HubChoiceDialog saved={saved} open={open} onOpenChange={setOpen} />
    </SettingsRow>
  );
}

/** The hub picker form: mode, URL, token and Apply and reload. */
function HubChoiceDialog({
  saved,
  open,
  onOpenChange,
}: {
  saved: HubChoiceView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<"local" | "remote">(saved.mode);
  const [url, setUrl] = useState(saved.url);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopLocal, setStopLocal] = useState(false);

  // A token is "saved" only while the form still points at the saved remote hub.
  const hasToken = saved.hasToken && mode === saved.mode && url.trim() === saved.url;

  const unchanged =
    mode === saved.mode && (mode === "local" || (url.trim() === saved.url && token === ""));

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      // The saved token never reaches this window, so a new URL needs the token typed in.
      const result = await invoke<SetResult>("hub_set_choice", {
        mode,
        url,
        token,
        stopLocal: mode === "remote" && stopLocal,
      });
      if (!result.ok) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[480px]" data-testid="settings__hub-dialog">
        <DialogHeader>
          <DialogTitle>Change hub</DialogTitle>
          <DialogDescription>
            Local runs the hub bundled with this app as a background service. Remote connects to a
            hub on another machine and starts nothing here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="hub-mode">
              Hub
            </label>
            <select
              id="hub-mode"
              data-testid="settings__hub-mode"
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as "local" | "remote")}
            >
              <option value="local">Local</option>
              <option value="remote">Remote</option>
            </select>
          </div>
          {mode === "remote" ? (
            <div className="space-y-2">
              <Input
                data-testid="settings__hub-url"
                aria-label="Hub URL"
                placeholder="https://hub.example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <Input
                data-testid="settings__hub-token"
                aria-label="Hub token"
                type="password"
                autoComplete="off"
                placeholder={hasToken ? "Token (saved, type to replace)" : "Token"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Use https:// unless the hub is on this machine.
              </p>
            </div>
          ) : null}
          {mode === "remote" && saved.localService ? (
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="hub-local-service">
                Hub on this Mac
              </label>
              <select
                id="hub-local-service"
                data-testid="settings__hub-local-service"
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={stopLocal ? "stop" : "keep"}
                onChange={(e) => setStopLocal(e.target.value === "stop")}
              >
                <option value="keep">Keep running</option>
                <option value="stop">Stop it</option>
              </select>
            </div>
          ) : null}
        </div>
        <DialogFooter className="items-center">
          {error ? (
            <ErrorPopover
              label="Could not connect to the hub"
              testId="settings__hub-error"
              message={error}
            />
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="settings__hub-apply"
            disabled={busy || unchanged}
            onClick={() => void apply()}
          >
            {busy ? "Connecting…" : "Apply and reload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
