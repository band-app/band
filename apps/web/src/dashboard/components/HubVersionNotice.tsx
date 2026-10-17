import { Button } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { compareHubVersion, isOldHubGap, setAppNewerThanHub } from "../../lib/hub-version";
import { trpc } from "../../lib/trpc-client";
import { ToastCard } from "./ToastCard";

const DISMISSED_KEY = "band:hub-older-notice-dismissed";

/**
 * Tells the user to update the hub when this app is a newer minor or major version than the
 * hub it talks to. Once the versions are known, a call to a procedure the old hub lacks that
 * nothing catches is dropped instead of reaching the full-screen error page. The dismissal is
 * remembered for the hub's version.
 */
export function HubVersionNotice() {
  const health = useQuery({
    queryKey: ["hub-version"],
    queryFn: () => trpc.services.health.query(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const hubVersion = health.data?.version;
  const newer = hubVersion ? compareHubVersion(__BAND_VERSION__, hubVersion) === "newer" : false;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === hubVersion;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    setAppNewerThanHub(newer);
    if (!newer) return;
    const quiet = (event: PromiseRejectionEvent) => {
      if (isOldHubGap(event.reason)) event.preventDefault();
    };
    window.addEventListener("unhandledrejection", quiet);
    return () => window.removeEventListener("unhandledrejection", quiet);
  }, [newer]);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISSED_KEY) === hubVersion);
    } catch {}
  }, [hubVersion]);

  if (!newer || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, hubVersion ?? "");
    } catch {}
  };

  return (
    <ToastCard testId="hub-version-notice" onClose={dismiss}>
      <div className="flex gap-2.5 pr-6">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="font-medium">Update the hub</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The hub runs {hubVersion}, this app is {__BAND_VERSION__}. Some features need a newer
            hub.
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="ghost" size="xs" onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    </ToastCard>
  );
}
