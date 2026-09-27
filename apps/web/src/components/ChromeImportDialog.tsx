/**
 * Import cookies and browsing history from a Chrome profile.
 *
 * Opening the dialog lists the Chrome profiles (display names only, from
 * Chrome's `Local State`) and whether Chrome is running. Nothing else is
 * read until the user picks what to bring over and clicks Import:
 *
 * - Cookies go into a new Band browser profile. The macOS Keychain dialog
 *   for "Chrome Safe Storage" appears during the import; denying it ends
 *   the import with an error here.
 * - Browsing history goes into this workspace's history (`history.import`).
 *
 * The desktop reads every selected Chrome DB before writing anything, so a
 * DB Chrome has locked fails the import as a whole. The server's profile
 * row is created last, so a failed import never leaves an empty profile.
 *
 * Saved passwords aren't offered: Band's browser has no password store or
 * autofill to put them in.
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@band-app/ui";
import { Chrome, Cookie, History, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  type ChromeCookieSummary,
  type ChromeProfile,
  clearBrowserProfileData,
  importChromeProfile,
  ipcErrorMessage,
  isChromeRunning,
  listChromeProfiles,
} from "../lib/chrome-import";
import { trpc } from "../lib/trpc-client";

/** How often the dialog re-checks whether Chrome is still running. */
const RUNNING_POLL_MS = 2000;

interface Selection {
  profile: string;
  cookies: boolean;
  history: boolean;
}

type Step =
  | { kind: "loading" }
  | { kind: "form"; profiles: ChromeProfile[]; error: string | null }
  | { kind: "importing"; profiles: ChromeProfile[] }
  | {
      kind: "done";
      profileName: string | null;
      cookies: ChromeCookieSummary | null;
      historyCount: number | null;
    }
  | { kind: "unavailable"; message: string };

export interface ChromeImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace whose history receives imported history. History is off without one. */
  workspaceId: string | null;
  /** Called with the new Band profile's id once its cookies are imported. */
  onImported: (profileId: string) => void;
}

export function ChromeImportDialog({
  open,
  onOpenChange,
  workspaceId,
  onImported,
}: ChromeImportDialogProps) {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [running, setRunning] = useState(false);
  const [selection, setSelection] = useState<Selection>({
    profile: "",
    cookies: true,
    history: true,
  });

  // List the Chrome profiles each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep({ kind: "loading" });
    listChromeProfiles()
      .then(({ supported, running, profiles }) => {
        if (cancelled) return;
        setRunning(running);
        if (!supported) {
          setStep({ kind: "unavailable", message: "Importing from Chrome only works on macOS." });
        } else if (profiles.length === 0) {
          setStep({ kind: "unavailable", message: "No Chrome profiles were found on this Mac." });
        } else {
          setSelection((s) => ({ ...s, profile: profiles[0]?.directory ?? "" }));
          setStep({ kind: "form", profiles, error: null });
        }
      })
      .catch((err) => {
        if (!cancelled) setStep({ kind: "unavailable", message: ipcErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Keep the "close Chrome" hint current while the user can still act on it.
  const polling = open && (step.kind === "form" || step.kind === "importing");
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      isChromeRunning()
        .then((r) => setRunning(r.running))
        .catch(() => {});
    }, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);

  const handleOpenChange = (next: boolean) => {
    // Don't let a stray click close the dialog mid-import.
    if (!next && step.kind === "importing") return;
    // Reset now, so reopening doesn't paint the last session for a frame.
    if (!next) setStep({ kind: "loading" });
    onOpenChange(next);
  };

  const profiles = step.kind === "form" || step.kind === "importing" ? step.profiles : null;
  const busy = step.kind === "importing";
  const chosen = profiles?.find((p) => p.directory === selection.profile);
  const cookiesAvailable = chosen?.hasCookies ?? false;
  const historyAvailable = workspaceId !== null && (chosen?.hasHistory ?? false);
  const wantCookies = selection.cookies && cookiesAvailable;
  const wantHistory = selection.history && historyAvailable;
  const canImport = step.kind === "form" && (wantCookies || wantHistory);

  const runImport = async (profiles: ChromeProfile[]) => {
    const chrome = profiles.find((p) => p.directory === selection.profile);
    if (!chrome) return;
    setStep({ kind: "importing", profiles });
    const profileId = `profile_${crypto.randomUUID()}`;
    const profileName = `${chrome.name} (Chrome)`;
    try {
      const result = await importChromeProfile({
        profileId,
        chromeProfileDirectory: chrome.directory,
        cookies: wantCookies,
        history: wantHistory,
      });
      let historyCount: number | null = null;
      if (result.history && workspaceId) {
        const { imported } = await trpc.history.import.mutate({
          workspaceId,
          entries: result.history,
        });
        historyCount = imported;
      }
      if (result.cookies) {
        await trpc.browserProfiles.create.mutate({
          id: profileId,
          name: profileName,
          source: "chrome",
        });
      }
      setStep({
        kind: "done",
        profileName: result.cookies ? profileName : null,
        cookies: result.cookies,
        historyCount,
      });
      if (result.cookies) onImported(profileId);
    } catch (err) {
      // Don't leave imported cookies in a partition no profile points at.
      if (wantCookies) clearBrowserProfileData(profileId).catch(() => {});
      setStep({ kind: "form", profiles, error: ipcErrorMessage(err) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[460px]" data-testid="chrome-import__dialog">
        <DialogHeader>
          <DialogTitle>Import from your browser</DialogTitle>
          <DialogDescription>Choose data to bring over to the built-in browser</DialogDescription>
        </DialogHeader>

        {step.kind === "loading" ? (
          <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Looking for Chrome profiles…
          </div>
        ) : null}

        {step.kind === "unavailable" ? (
          <p className="text-sm text-destructive" role="alert">
            {step.message}
          </p>
        ) : null}

        {profiles ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">From</span>
              <Select
                value={selection.profile}
                onValueChange={(profile) => setSelection((s) => ({ ...s, profile }))}
                disabled={busy}
              >
                <SelectTrigger
                  className="flex-1"
                  aria-label="Chrome profile"
                  data-testid="chrome-import__profile"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.directory} value={p.directory}>
                      <Chrome className="size-4" />
                      <span>Google Chrome</span>
                      <span className="text-muted-foreground">{p.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {running ? (
              <p
                className="text-sm text-amber-600 dark:text-amber-400"
                data-testid="chrome-import__running-hint"
              >
                Close Google Chrome completely before importing
              </p>
            ) : null}

            <div className="divide-y divide-border rounded-lg border border-border">
              <ImportToggle
                id="chrome-import-cookies"
                icon={<Cookie className="size-4" />}
                label="Cookies"
                checked={wantCookies}
                disabled={busy || !cookiesAvailable}
                onCheckedChange={(cookies) => setSelection((s) => ({ ...s, cookies }))}
              />
              <ImportToggle
                id="chrome-import-history"
                icon={<History className="size-4" />}
                label="Browsing history"
                checked={wantHistory}
                disabled={busy || !historyAvailable}
                onCheckedChange={(history) => setSelection((s) => ({ ...s, history }))}
              />
            </div>

            {wantCookies ? (
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                <li>
                  Cookies go into a new browser profile, so sites you're signed in to in Chrome are
                  signed in here too. That includes tabs coding agents drive.
                </li>
                <li>
                  macOS will ask to allow access to "Chrome Safe Storage". Band uses it only to
                  decrypt the cookies, which stay on this Mac.
                </li>
                <li>Google sign-ins are not copied. Sign in to Google again in Band.</li>
              </ul>
            ) : null}
            {wantHistory ? (
              <p className="text-xs text-muted-foreground">
                History is added to this workspace's browser history.
              </p>
            ) : null}

            {busy ? (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Importing. Answer the macOS Keychain prompt if it appears.
              </div>
            ) : null}
            {step.kind === "form" && step.error ? (
              <p
                className="text-sm text-destructive"
                role="alert"
                data-testid="chrome-import__error"
              >
                {step.error}
              </p>
            ) : null}
          </div>
        ) : null}

        {step.kind === "done" ? (
          <div className="space-y-1 text-sm" data-testid="chrome-import__summary">
            {step.cookies && step.profileName ? (
              <p>
                Imported {step.cookies.imported} cookies into "{step.profileName}". This tab now
                uses it, and so will new browser tabs in this project.
              </p>
            ) : null}
            {step.historyCount !== null ? (
              <p>Imported {step.historyCount} history entries into this workspace.</p>
            ) : null}
            {step.cookies && step.cookies.skippedGoogle > 0 ? (
              <p className="text-muted-foreground">
                Skipped {step.cookies.skippedGoogle} Google cookies. Sign in to Google in Band.
              </p>
            ) : null}
            {step.cookies && step.cookies.undecryptable + step.cookies.rejected > 0 ? (
              <p className="text-muted-foreground">
                {step.cookies.undecryptable + step.cookies.rejected} cookies could not be copied.
                Sign in to those sites again.
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {step.kind === "done" || step.kind === "unavailable" ? (
            <Button onClick={() => handleOpenChange(false)}>
              {step.kind === "done" ? "Done" : "Close"}
            </Button>
          ) : (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={!canImport}
                onClick={() => {
                  if (step.kind === "form") void runImport(step.profiles);
                }}
              >
                Import
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportToggle({
  id,
  icon,
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  icon: ReactNode;
  label: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="text-muted-foreground">{icon}</span>
      <label htmlFor={id} className="flex-1 text-sm">
        {label}
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}
