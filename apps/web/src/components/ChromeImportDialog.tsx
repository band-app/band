/**
 * Import a Chrome profile's cookies into a new Band browser profile.
 *
 * Steps: ask for consent (nothing reads Chrome data before the user clicks
 * Continue), list the Chrome profiles, import the picked one, show counts.
 * The macOS Keychain dialog for "Chrome Safe Storage" appears during the
 * import step; denying it ends the import with an error here.
 *
 * The desktop imports into the new profile's session partition first and
 * the server row is created afterwards, so a failed import never leaves an
 * empty profile behind.
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import {
  type ChromeImportSummary,
  type ChromeProfile,
  clearBrowserProfileData,
  importChromeProfile,
  ipcErrorMessage,
  listChromeProfiles,
} from "../lib/chrome-import";
import { trpc } from "../lib/trpc-client";

type Step =
  | { kind: "consent" }
  | { kind: "loading" }
  | { kind: "pick"; profiles: ChromeProfile[]; selected: string }
  | { kind: "importing"; chromeName: string }
  | { kind: "done"; profileName: string; summary: ChromeImportSummary }
  | { kind: "error"; message: string };

export interface ChromeImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new Band profile's id once its cookies are imported. */
  onImported: (profileId: string) => void;
}

export function ChromeImportDialog({ open, onOpenChange, onImported }: ChromeImportDialogProps) {
  const [step, setStep] = useState<Step>({ kind: "consent" });

  const handleOpenChange = (next: boolean) => {
    // Don't let a stray click close the dialog mid-import.
    if (!next && step.kind === "importing") return;
    if (!next) setStep({ kind: "consent" });
    onOpenChange(next);
  };

  const loadProfiles = async () => {
    setStep({ kind: "loading" });
    try {
      const { supported, profiles } = await listChromeProfiles();
      if (!supported) {
        setStep({ kind: "error", message: "Importing from Chrome only works on macOS." });
      } else if (profiles.length === 0) {
        setStep({ kind: "error", message: "No Chrome profiles with cookies were found." });
      } else {
        setStep({ kind: "pick", profiles, selected: profiles[0]?.directory ?? "" });
      }
    } catch (err) {
      setStep({ kind: "error", message: ipcErrorMessage(err) });
    }
  };

  const runImport = async (chrome: ChromeProfile) => {
    setStep({ kind: "importing", chromeName: chrome.name });
    const profileId = `profile_${crypto.randomUUID()}`;
    const profileName = `${chrome.name} (Chrome)`;
    try {
      const summary = await importChromeProfile(profileId, chrome.directory);
      await trpc.browserProfiles.create.mutate({
        id: profileId,
        name: profileName,
        source: "chrome",
      });
      setStep({ kind: "done", profileName, summary });
      onImported(profileId);
    } catch (err) {
      // Don't leave imported cookies in a partition no profile points at.
      clearBrowserProfileData(profileId).catch(() => {});
      setStep({ kind: "error", message: ipcErrorMessage(err) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[440px]" data-testid="chrome-import__dialog">
        <DialogHeader>
          <DialogTitle>Import from Chrome</DialogTitle>
          {step.kind === "consent" ? (
            <DialogDescription>
              Band will read your Chrome profile list, then copy the cookies of the profile you pick
              into a new Band browser profile, so sites you're signed in to in Chrome are signed in
              here too.
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {step.kind === "consent" ? (
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              macOS will ask you to allow access to "Chrome Safe Storage" in your Keychain. Band
              uses it only to decrypt the cookies.
            </li>
            <li>
              The cookies stay on this Mac, in the new profile. Band doesn't send them to its
              server, and tabs in the profile can't be streamed to the web UI.
            </li>
            <li>
              Anything done in a tab using this profile is signed in, including by coding agents
              that drive Band browser tabs.
            </li>
            <li>Google sign-ins are not copied. Sign in to Google again in Band.</li>
          </ul>
        ) : null}

        {step.kind === "loading" || step.kind === "importing" ? (
          <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {step.kind === "loading"
              ? "Looking for Chrome profiles…"
              : `Importing cookies from ${step.chromeName}. Answer the macOS Keychain prompt if it appears.`}
          </div>
        ) : null}

        {step.kind === "pick" ? (
          <fieldset className="space-y-1">
            <legend className="mb-2 text-sm text-muted-foreground">Chrome profile</legend>
            {step.profiles.map((p) => (
              <label
                key={p.directory}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
              >
                <input
                  type="radio"
                  name="chrome-profile"
                  value={p.directory}
                  checked={step.selected === p.directory}
                  onChange={() => setStep({ ...step, selected: p.directory })}
                />
                {p.name}
              </label>
            ))}
          </fieldset>
        ) : null}

        {step.kind === "done" ? (
          <div className="space-y-1 text-sm">
            <p>
              Imported {step.summary.imported} cookies into "{step.profileName}". This tab now uses
              it, and so will new browser tabs in this project.
            </p>
            {step.summary.skippedGoogle > 0 ? (
              <p className="text-muted-foreground">
                Skipped {step.summary.skippedGoogle} Google cookies. Sign in to Google in Band.
              </p>
            ) : null}
            {step.summary.undecryptable + step.summary.rejected > 0 ? (
              <p className="text-muted-foreground">
                {step.summary.undecryptable + step.summary.rejected} cookies could not be copied.
                Sign in to those sites again.
              </p>
            ) : null}
          </div>
        ) : null}

        {step.kind === "error" ? (
          <p className="text-sm text-destructive" role="alert">
            {step.message}
          </p>
        ) : null}

        <DialogFooter>
          {step.kind === "consent" ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={loadProfiles}>Continue</Button>
            </>
          ) : null}
          {step.kind === "pick" ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const chrome = step.profiles.find((p) => p.directory === step.selected);
                  if (chrome) void runImport(chrome);
                }}
              >
                Import
              </Button>
            </>
          ) : null}
          {step.kind === "done" || step.kind === "error" ? (
            <Button onClick={() => handleOpenChange(false)}>
              {step.kind === "done" ? "Done" : "Close"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
