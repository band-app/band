import { useEffect, useState } from "react";
import { useAdapter } from "../context";
import type { HooksStatus } from "../types";

export type HooksSetupState =
  | { status: "checking" }
  | { status: "installed" }
  | { status: "needs_install"; otherHooksExist: boolean }
  | { status: "error"; message: string };

export function useHooksSetup() {
  const adapter = useAdapter();
  const [state, setState] = useState<HooksSetupState>({ status: "checking" });

  useEffect(() => {
    (async () => {
      try {
        const result: HooksStatus = await adapter.checkHooks();

        if (result.installed) {
          setState({ status: "installed" });
          return;
        }

        if (result.other_hooks_exist) {
          setState({ status: "needs_install", otherHooksExist: true });
        } else {
          // No hooks at all — auto-install
          await adapter.installHooks();
          setState({ status: "installed" });
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
      await adapter.installHooks();
      setState({ status: "installed" });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { state, install };
}
