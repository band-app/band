import { useEffect, useState } from "react";
import { useAdapter } from "../context";
import type { CliStatus } from "../types";

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

  useEffect(() => {
    (async () => {
      try {
        const result: CliStatus = await adapter.checkCli();

        switch (result) {
          case "Installed":
            setState({ status: "installed" });
            break;
          case "NotInstalled":
            // No existing binary — auto-install
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
              reason: "/usr/local/bin does not exist",
            });
            break;
          case "NotWritable":
            setState({
              status: "manual",
              reason: "/usr/local/bin is not writable",
            });
            break;
        }
      } catch (err) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, [adapter]);

  const install = async () => {
    try {
      await adapter.installCli();
      // Re-check to confirm it actually worked
      const result = await adapter.checkCli();
      if (result === "Installed") {
        setState({ status: "installed" });
      } else {
        setState({
          status: "manual",
          reason: `Install completed but CLI check still reports: ${result}`,
        });
      }
    } catch (err) {
      setState({
        status: "manual",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { state, install };
}
