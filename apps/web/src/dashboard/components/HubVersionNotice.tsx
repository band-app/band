import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { compareHubVersion, isOldHubGap, setAppNewerThanHub } from "../../lib/hub-version";
import { trpc } from "../../lib/trpc-client";
import { Notification } from "./Notification";

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
    <Notification
      testId="hub-version-notice"
      severity="warning"
      title="Update the hub"
      details={`The hub runs ${hubVersion}, this app is ${__BAND_VERSION__}. Some features need a newer hub.`}
      actions={[{ label: "Dismiss", onClick: dismiss }]}
      onClose={dismiss}
    />
  );
}
