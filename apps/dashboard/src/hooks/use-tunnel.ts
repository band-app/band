import { isServiceHealthy, type ServiceHealth, useSettingsStore } from "@band/dashboard-core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

interface PrereqStatus {
  node: boolean;
  instatunnel: boolean;
}

const HEALTH_POLL_INTERVAL = 30_000;

export function useTunnel() {
  const [webServerRunning, setWebServerRunning] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelRemoteHost, setTunnelRemoteHost] = useState<string | null>(null);
  const [showPrereq, setShowPrereq] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const shouldBeRunningRef = useRef(false);
  const isRecoveringRef = useRef(false);
  const settings = useSettingsStore((s) => s.settings);

  // Health polling — check service status every 30s, recover if shouldBeRunning
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const recover = async (health: ServiceHealth) => {
      if (isRecoveringRef.current) return;
      isRecoveringRef.current = true;
      try {
        if (!health.webserver) {
          await invoke("webserver_start");
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            if (cancelled) return;
            const h = await invoke<ServiceHealth>("service_health_check");
            if (h.webserver) break;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        if (cancelled) return;
        await invoke<string>("webserver_get_token");
        if (cancelled) return;
        if (!health.tunnel) {
          await invoke("tunnel_start");
        }
      } catch {
        // swallow — next poll tick will retry
      } finally {
        isRecoveringRef.current = false;
      }
    };

    const poll = async () => {
      try {
        const health = await invoke<ServiceHealth>("service_health_check");
        if (cancelled) return;
        setWebServerRunning(isServiceHealthy(health, settings.tunnelSubdomain));
        if (health.tunnel && health.tunnel_url) {
          setTunnelUrl((prev) => prev ?? health.tunnel_url);
        } else if (!health.tunnel) {
          setTunnelUrl(null);
        }
        setTunnelRemoteHost(health.tunnel_remote_host);

        if (shouldBeRunningRef.current && (!health.webserver || !health.tunnel)) {
          recover(health);
        }
      } catch {
        // ignore errors during polling
      }
    };

    poll();
    intervalId = setInterval(poll, HEALTH_POLL_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [settings.tunnelSubdomain]);

  // Persistent tunnel-url listener (works even when dialog is closed)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("tunnel-url", (event) => {
      shouldBeRunningRef.current = true;
      setTunnelUrl(event.payload);
      setWebServerRunning(true);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Listen for tunnel-remote-host events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("tunnel-remote-host", (event) => {
      setTunnelRemoteHost(event.payload);
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
      shouldBeRunningRef.current = false;
      setShowDialog(true);
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
        const status = await invoke<PrereqStatus>("prereq_check");
        if (!status.node || !status.instatunnel || cancelled) return;
        shouldBeRunningRef.current = true;
      } catch {
        // ignore — health poll will retry
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [settings.autoStartTunnel]);

  // Globe click → fresh health check, update state, then open prereq dialog
  const openDialog = useCallback(async () => {
    shouldBeRunningRef.current = true;
    try {
      const health = await invoke<ServiceHealth>("service_health_check");
      setWebServerRunning(isServiceHealthy(health, settings.tunnelSubdomain));
      if (health.tunnel && health.tunnel_url) {
        setTunnelUrl((prev) => prev ?? health.tunnel_url);
      } else if (!health.tunnel) {
        setTunnelUrl(null);
      }
      setTunnelRemoteHost(health.tunnel_remote_host);
    } catch {
      // continue to dialog even if check fails
    }
    setShowPrereq(true);
  }, [settings.tunnelSubdomain]);

  // Prereq passed → open tunnel dialog
  const onPrereqReady = useCallback(() => {
    setShowPrereq(false);
    setShowDialog(true);
  }, []);

  const handleStopped = useCallback(() => {
    shouldBeRunningRef.current = false;
    isRecoveringRef.current = false;
    setWebServerRunning(false);
    setTunnelUrl(null);
    setTunnelRemoteHost(null);
    setShowDialog(false);
  }, []);

  return {
    webServerRunning,
    tunnelUrl,
    tunnelRemoteHost,
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
