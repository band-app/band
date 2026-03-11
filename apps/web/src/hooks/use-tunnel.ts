import { isServiceHealthy, useSettingsQuery } from "@band/dashboard-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc-client";

const HEALTH_POLL_INTERVAL = 30_000;

export function useTunnel() {
  const [webServerRunning, setWebServerRunning] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelRemoteHost, setTunnelRemoteHost] = useState<string | null>(null);
  const [showPrereq, setShowPrereq] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const shouldBeRunningRef = useRef(false);
  const isRecoveringRef = useRef(false);
  const { settings } = useSettingsQuery();

  // Health polling — check service status every 30s, recover tunnel if shouldBeRunning
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const recover = async (health: { tunnel: boolean }) => {
      if (isRecoveringRef.current) return;
      isRecoveringRef.current = true;
      try {
        // Web server is always running (we are it), only restart tunnel
        if (!health.tunnel && !cancelled) {
          const result = await trpc.tunnel.start.mutate({});
          if (result.url) {
            setTunnelUrl(result.url);
            setWebServerRunning(true);
          }
        }
      } catch {
        // swallow — next poll tick will retry
      } finally {
        isRecoveringRef.current = false;
      }
    };

    const poll = async () => {
      try {
        const health = await trpc.services.health.query();
        if (cancelled) return;
        setWebServerRunning(isServiceHealthy(health, settings.tunnelSubdomain));
        if (health.tunnel && health.tunnel_url) {
          setTunnelUrl((prev) => prev ?? health.tunnel_url);
        } else if (!health.tunnel) {
          setTunnelUrl(null);
        }
        setTunnelRemoteHost(health.tunnel_remote_host);

        if (shouldBeRunningRef.current && !health.tunnel) {
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

  // Persistent tRPC subscription listener for tunnel events (works even when dialog is closed)
  useEffect(() => {
    const subscription = trpc.status.stream.subscribe(undefined, {
      onData: (event: { kind: string; url?: string; host?: string }) => {
        if (event.kind === "tunnel-url" && event.url) {
          shouldBeRunningRef.current = true;
          setTunnelUrl(event.url);
          setWebServerRunning(true);
        } else if (event.kind === "tunnel-remote-host" && event.host) {
          setTunnelRemoteHost(event.host);
        } else if (event.kind === "tunnel-subdomain-taken") {
          shouldBeRunningRef.current = false;
          setShowDialog(true);
        }
      },
    });
    return () => subscription.unsubscribe();
  }, []);

  // Globe click → fresh health check, update state, then open prereq dialog
  const openDialog = useCallback(async () => {
    shouldBeRunningRef.current = true;
    try {
      const health = await trpc.services.health.query();
      setWebServerRunning(isServiceHealthy(health, settings.tunnelSubdomain));
      if (health.tunnel && health.tunnel_url) {
        setTunnelUrl((prev) => prev ?? health.tunnel_url);
      } else if (!health.tunnel) {
        setTunnelUrl(null);
      }
      setTunnelRemoteHost(health.tunnel_remote_host ?? null);
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
