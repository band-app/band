import { useCallback, useEffect, useState } from "react";

import { getElectronBridge } from "@/lib/desktop-ipc";

/**
 * The desktop app's keep-awake switch. `available` is false outside the
 * desktop shell, so callers render nothing there.
 */
export function useKeepAwake(): {
  available: boolean;
  enabled: boolean;
  toggle: () => void;
} {
  const bridge = getElectronBridge();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    bridge
      .invoke("keep_awake_get")
      .then((r) => setEnabled((r as { enabled: boolean }).enabled === true))
      .catch(() => {});
  }, [bridge]);

  const toggle = useCallback(() => {
    if (!bridge) return;
    bridge
      .invoke("keep_awake_set", { enabled: !enabled })
      .then((r) => setEnabled((r as { enabled: boolean }).enabled === true))
      .catch(() => {});
  }, [bridge, enabled]);

  return { available: bridge !== null, enabled, toggle };
}
