import { Button, Spinner } from "@band-app/ui";
import { CircleAlert, CircleCheck, Download, RotateCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { openExternalUrl } from "../../lib/open-external-url";
import type { UpdateRelease } from "../adapter";
import { useAppUpdate } from "../hooks/use-app-update";

/**
 * Bottom-right toast for the desktop auto-updater. Shows "Checking for
 * updates…" and the result of a user-initiated check, and any update a
 * background check finds, then follows it through download and restart.
 * Renders nothing outside the desktop shell.
 */
export function UpdateToast() {
  const { status, download, restart, retry, dismiss } = useAppUpdate();
  if (!status) return null;

  let body: ReactNode;
  let closable = true;
  switch (status.state) {
    case "checking":
      closable = false;
      body = <ToastHeader icon={<Spinner className="size-4" />} title="Checking for updates…" />;
      break;
    case "up-to-date":
      body = (
        <ToastHeader
          icon={<CircleCheck className="size-4 text-emerald-500" />}
          title="You're on the latest version"
          detail={`Band v${status.currentVersion}`}
        />
      );
      break;
    case "available":
      body = (
        <>
          <ToastHeader
            icon={<Download className="size-4 text-blue-500" />}
            title={`Band v${status.version} is available`}
            detail={`You have v${status.currentVersion}.`}
          />
          <ReleaseInfo release={status} />
          <ToastActions>
            <Button variant="ghost" size="xs" onClick={dismiss}>
              Later
            </Button>
            <Button size="xs" onClick={download}>
              Update
            </Button>
          </ToastActions>
        </>
      );
      break;
    case "downloading":
      closable = false;
      body = (
        <>
          <ToastHeader
            icon={<Spinner className="size-4" />}
            title={`Downloading Band v${status.version}…`}
            detail={`${status.percent}%`}
          />
          <div
            role="progressbar"
            aria-label="Update download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={status.percent}
            className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
              style={{ width: `${status.percent}%` }}
            />
          </div>
        </>
      );
      break;
    case "downloaded":
      body = (
        <>
          <ToastHeader
            icon={<CircleCheck className="size-4 text-emerald-500" />}
            title={`Band v${status.version} is ready`}
            detail="Restart Band to finish updating. It also installs when you quit."
          />
          <ToastActions>
            <Button variant="ghost" size="xs" onClick={dismiss}>
              Later
            </Button>
            <Button size="xs" onClick={restart}>
              <RotateCw />
              Restart to update
            </Button>
          </ToastActions>
        </>
      );
      break;
    case "error":
      body = (
        <>
          <ToastHeader
            icon={<CircleAlert className="size-4 text-destructive" />}
            title={
              status.phase === "download"
                ? "Couldn't download the update"
                : "Couldn't check for updates"
            }
            detail={status.message}
          />
          <ToastActions>
            <Button variant="outline" size="xs" onClick={retry}>
              Retry
            </Button>
          </ToastActions>
        </>
      );
      break;
  }

  return (
    <output
      aria-live="polite"
      data-testid="update-toast"
      className="fixed right-4 bottom-4 left-4 z-50 block rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2 duration-200 sm:left-auto sm:w-80"
    >
      {closable && (
        <button
          type="button"
          aria-label="Close"
          onClick={dismiss}
          className="absolute top-2 right-2 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
      {body}
    </output>
  );
}

function ToastHeader({ icon, title, detail }: { icon: ReactNode; title: string; detail?: string }) {
  return (
    <div className="flex gap-2.5 pr-6">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        {detail && (
          <p className="mt-0.5 line-clamp-3 break-words text-xs text-muted-foreground">{detail}</p>
        )}
      </div>
    </div>
  );
}

function ReleaseInfo({ release }: { release: UpdateRelease }) {
  return (
    <div className="mt-2 pl-6.5">
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
    </div>
  );
}

function ToastActions({ children }: { children: ReactNode }) {
  return <div className="mt-3 flex justify-end gap-2">{children}</div>;
}
