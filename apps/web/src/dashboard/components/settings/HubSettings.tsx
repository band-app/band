import { Button, Input } from "@band-app/ui";
import { useEffect, useState } from "react";
import { invoke } from "../../../lib/desktop-ipc";
import { SettingsRow } from "./SettingsRow";

interface HubChoiceView {
  mode: "local" | "remote";
  url: string;
  hasToken: boolean;
}

type SetResult = { ok: true } | { ok: false; error: string };

/**
 * Rows for the Settings dialog's Hub section (desktop app only): the hub this
 * window talks to. Local runs the hub bundled with the app. Remote connects to
 * a hub at another URL with its token and starts nothing locally. Applying a
 * change reloads the window, so it is not part of the dialog's Save.
 */
export function HubSettings() {
  const [mode, setMode] = useState<"local" | "remote">("local");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [saved, setSaved] = useState<HubChoiceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<HubChoiceView>("hub_get_choice")
      .then((choice) => {
        if (cancelled) return;
        setSaved(choice);
        setMode(choice.mode);
        setUrl(choice.url);
        setHasToken(choice.hasToken);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!saved) return null;

  const unchanged =
    mode === saved.mode && (mode === "local" || (url.trim() === saved.url && token === ""));

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      // The saved token never reaches this window, so a new URL needs the token typed in.
      const result = await invoke<SetResult>("hub_set_choice", { mode, url, token });
      if (!result.ok) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsRow
        htmlFor="hub-mode"
        label="Hub"
        description="Local runs the hub bundled with this app. Remote connects to a hub on another machine and starts nothing here."
      >
        <select
          id="hub-mode"
          data-testid="settings__hub-mode"
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          value={mode}
          onChange={(e) => setMode(e.target.value as "local" | "remote")}
        >
          <option value="local">Local</option>
          <option value="remote">Remote</option>
        </select>
      </SettingsRow>
      {mode === "remote" ? (
        <SettingsRow
          variant="stacked"
          label="Remote hub"
          description="The hub's URL and its token. Use https:// unless the hub is on this machine."
        >
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
          </div>
        </SettingsRow>
      ) : null}
      <SettingsRow variant="stacked">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            data-testid="settings__hub-apply"
            disabled={busy || unchanged}
            onClick={() => void apply()}
          >
            {busy ? "Connecting…" : "Apply and reload"}
          </Button>
          {error ? (
            <p role="alert" data-testid="settings__hub-error" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </SettingsRow>
    </>
  );
}
