import { useRawDashboardStore, useSettingsStore } from "@band/dashboard-core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

interface PrereqStatus {
  node: boolean;
  instatunnel: boolean;
}

export function useTunnel() {
  const dashboardStore = useRawDashboardStore();
  const [webServerRunning, setWebServerRunning] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [showPrereq, setShowPrereq] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const stoppedRef = useRef(false);
  const settings = useSettingsStore((s) => s.settings);

  useEffect(() => {
    invoke<boolean>("webserver_status")
      .then(setWebServerRunning)
      .catch(() => {});
    invoke<string | null>("tunnel_status")
      .then((url) => {
        if (url) setTunnelUrl(url);
      })
      .catch(() => {});
  }, []);

  // Persistent tunnel-url listener (works even when dialog is closed)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("tunnel-url", (event) => {
      setTunnelUrl(event.payload);
      setWebServerRunning(true);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Auto-restart on tunnel-exited (handles 24h expiry)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("tunnel-exited", () => {
      if (!stoppedRef.current) {
        invoke("tunnel_start").catch(() => {});
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Open dialog when subdomain is taken so user can choose fallback
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("tunnel-subdomain-taken", () => {
      if (!stoppedRef.current) {
        setShowDialog(true);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Auto-start on app launch if enabled
  useEffect(() => {
    if (!settings.autoStartTunnel) return;

    let cancelled = false;
    (async () => {
      try {
        const running = await invoke<boolean>("webserver_status");
        if (running || cancelled) return;

        // Skip auto-start if prerequisites are missing
        const status = await invoke<PrereqStatus>("prereq_check");
        if (!status.node || !status.instatunnel || cancelled) return;

        await invoke("webserver_start");
        await invoke("webserver_wait_ready");
        await invoke<string>("webserver_get_token");
        if (cancelled) return;
        setWebServerRunning(true);
        await invoke("tunnel_start");
      } catch (e) {
        if (!cancelled) {
          dashboardStore.getState().clearError();
          dashboardStore.setState({ error: String(e) });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [settings.autoStartTunnel, dashboardStore]);

  // Globe click → open prereq check first
  const openDialog = useCallback(() => {
    stoppedRef.current = false;
    setShowPrereq(true);
  }, []);

  // Prereq passed → open tunnel dialog
  const onPrereqReady = useCallback(() => {
    setShowPrereq(false);
    setShowDialog(true);
  }, []);

  const handleStopped = useCallback(() => {
    stoppedRef.current = true;
    setWebServerRunning(false);
    setTunnelUrl(null);
    setShowDialog(false);
  }, []);

  return {
    webServerRunning,
    tunnelUrl,
    setTunnelUrl,
    showPrereq,
    setShowPrereq,
    onPrereqReady,
    showDialog,
    setShowDialog,
    openDialog,
    handleStopped,
  };
}
