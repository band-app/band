import { useEffect, useState } from "react";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface HooksStatus {
  installed: boolean;
  other_hooks_exist: boolean;
}

export type HooksSetupState =
  | { status: "checking" }
  | { status: "installed" }
  | { status: "needs_install"; otherHooksExist: boolean }
  | { status: "error"; message: string };

export function useHooksSetup() {
  const [state, setState] = useState<HooksSetupState>({ status: "checking" });

  useEffect(() => {
    if (!isTauri()) {
      setState({ status: "installed" });
      return;
    }

    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<HooksStatus>("hooks_check");

        if (result.installed) {
          setState({ status: "installed" });
          return;
        }

        if (result.other_hooks_exist) {
          // Other hooks exist but Band hooks are not installed — show banner
          setState({ status: "needs_install", otherHooksExist: true });
        } else {
          // No hooks at all — auto-install
          await invoke("hooks_install");
          setState({ status: "installed" });
        }
      } catch (err) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, []);

  const install = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("hooks_install");
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
