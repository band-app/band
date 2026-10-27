import { useCallback, useEffect, useRef, useState } from "react";
import { useAdapter } from "../context";

export type CliSetupState =
  | { status: "checking" }
  | { status: "installed" }
  | { status: "not_installed" }
  | { status: "conflict" }
  | { status: "manual"; reason: string }
  | { status: "error"; message: string };

export function useCliSetup() {
  const adapter = useAdapter();
  const [state, setState] = useState<CliSetupState>({ status: "checking" });
  const autoInstalled = useRef(false);

  // Checks the hub and updates the banner state. A background check (page load, window focus)
  // installs a missing CLI once; a person's explicit Install is `install` below.
  const checking = useRef(false);
  const check = useCallback(async () => {
    // Focus can fire again while a check (or its auto-install) is still running.
    if (checking.current) return;
    checking.current = true;
    try {
      const { status, applicable } = await adapter.checkCli();
      // Nobody can act on the hub's CLI from here (no local worker, or not an admin).
      if (!applicable) {
        setState({ status: "installed" });
        return;
      }
      switch (status) {
        case "Installed":
          setState({ status: "installed" });
          break;
        case "NotInstalled":
          // No existing binary: auto-install, but only once, so a failing install is not
          // retried on every focus.
          if (autoInstalled.current) {
            setState((prev) =>
              prev.status === "manual"
                ? prev
                : { status: "manual", reason: "The band CLI is not installed" },
            );
            break;
          }
          autoInstalled.current = true;
          try {
            await adapter.installCli();
            setState({ status: "installed" });
          } catch (err) {
            setState({
              status: "manual",
              reason: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        case "ConflictingBinary":
          setState({ status: "conflict" });
          break;
        case "DirNotFound":
          setState({
            status: "manual",
            reason: "The directory for the band link does not exist on the hub's server",
          });
          break;
        case "NotWritable":
          setState({
            status: "manual",
            reason: "The directory for the band link is not writable on the hub's server",
          });
          break;
      }
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      checking.current = false;
    }
  }, [adapter]);

  useEffect(() => {
    void check();
    // The problem may be fixed outside the app, so check again when the window regains focus.
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [check]);

  const install = async () => {
    try {
      // Explicit user action — allow OS-level admin prompt when needed
      await adapter.installCli({ allowPrompt: true });
    } catch (err) {
      // The install may have failed on a path that is fine now; look again before blaming it.
      const { status, applicable } = await adapter.checkCli().catch(() => ({
        status: "NotInstalled" as const,
        applicable: true,
      }));
      if (!applicable || status === "Installed") {
        setState({ status: "installed" });
        return;
      }
      setState({
        status: "manual",
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // Re-check to confirm it actually worked
    const { status } = await adapter.checkCli();
    if (status === "Installed") {
      setState({ status: "installed" });
    } else {
      setState({
        status: "manual",
        reason: `Install completed but CLI check still reports: ${status}`,
      });
    }
  };

  return { state, install };
}
