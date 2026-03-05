import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useDashboardStore } from "@/stores/dashboard-store";

export function useTunnel() {
  const [webServerRunning, setWebServerRunning] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);

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

  const openDialog = useCallback(async () => {
    if (webServerRunning) {
      setShowDialog(true);
      return;
    }
    try {
      await invoke("webserver_start");
      await invoke("webserver_wait_ready");
      setWebServerRunning(true);
      setShowDialog(true);
    } catch (e) {
      useDashboardStore.getState().clearError();
      useDashboardStore.setState({ error: String(e) });
    }
  }, [webServerRunning]);

  const handleStopped = useCallback(() => {
    setWebServerRunning(false);
    setTunnelUrl(null);
    setShowDialog(false);
  }, []);

  return {
    webServerRunning,
    tunnelUrl,
    setTunnelUrl,
    showDialog,
    setShowDialog,
    openDialog,
    handleStopped,
  };
}
