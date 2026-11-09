import { Spinner } from "@band-app/ui";
import { RotateCw } from "lucide-react";
import { openExternalUrl } from "../../lib/open-external-url";
import type { UpdateRelease } from "../adapter";
import { useAppUpdate } from "../hooks/use-app-update";
import { Notification } from "./Notification";

/**
 * Notification for the desktop auto-updater, shown in the bottom-right stack. Shows "Checking for
 * updates…" and the result of a user-initiated check, and any update a
 * background check finds, then follows it through download and restart.
 * Renders nothing outside the desktop shell.
 */
export function UpdateToast() {
  const { status, download, restart, retry, dismiss } = useAppUpdate();
  if (!status) return null;
  const testId = "update-toast";

  switch (status.state) {
    case "checking":
      return (
        <Notification
          testId={testId}
          severity="info"
          icon={<Spinner className="size-4" />}
          title="Checking for updates…"
        />
      );
    case "up-to-date":
      return (
        <Notification
          testId={testId}
          severity="success"
          title="You're on the latest version"
          details={`Band v${status.currentVersion}`}
          onClose={dismiss}
        />
      );
    case "available":
      return (
        <Notification
          testId={testId}
          severity="info"
          title={`Band v${status.version} is available`}
          details={`You have v${status.currentVersion}.`}
          actions={[
            { label: "Later", onClick: dismiss },
            { label: "Update", onClick: download, primary: true },
          ]}
          onClose={dismiss}
        >
          <ReleaseInfo release={status} />
        </Notification>
      );
    case "downloading":
      return (
        <Notification
          testId={testId}
          severity="info"
          icon={<Spinner className="size-4" />}
          title={`Downloading Band v${status.version}…`}
          details={`${status.percent}%`}
          progress={status.percent / 100}
          progressLabel="Update download"
        />
      );
    case "downloaded":
      return (
        <Notification
          testId={testId}
          severity="success"
          title={`Band v${status.version} is ready`}
          details="Restart Band to finish updating. It also installs when you quit."
          actions={[
            { label: "Later", onClick: dismiss },
            { label: "Restart to update", onClick: restart, primary: true, icon: <RotateCw /> },
          ]}
          onClose={dismiss}
        />
      );
    case "error":
      return (
        <Notification
          testId={testId}
          severity="error"
          title={
            status.phase === "download"
              ? "Couldn't download the update"
              : "Couldn't check for updates"
          }
          details={status.message}
          actions={[{ label: "Retry", onClick: retry }]}
          onClose={dismiss}
        />
      );
  }
}

function ReleaseInfo({ release }: { release: UpdateRelease }) {
  return (
    <>
      {release.releaseNotes && (
        <p className="max-h-28 overflow-y-auto whitespace-pre-line text-xs text-muted-foreground">
          {release.releaseNotes}
        </p>
      )}
      <button
        type="button"
        onClick={() => openExternalUrl(release.releaseUrl)}
        className="mt-1.5 text-xs text-primary underline-offset-4 hover:underline"
      >
        Release notes on GitHub
      </button>
    </>
  );
}
