import { isServiceHealthy } from "@band/dashboard-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc-client";

const HEALTH_POLL_INTERVAL = 30_000;

export function useTunnel() {
  const [webServerRunning, setWebServerRunning] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [showPrereq, setShowPrereq] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const hadTunnelRef = useRef(false);

  // Health polling — sync UI state with server every 30s
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const poll = async () => {
      try {
        const health = await trpc.services.health.query();
        if (cancelled) return;
        setWebServerRunning(isServiceHealthy(health));
        if (health.tunnel && health.tunnel_url) {
          hadTunnelRef.current = true;
          setTunnelUrl((prev) => prev ?? health.tunnel_url);
          setTunnelError(null);
        } else if (!health.tunnel) {
          setTunnelUrl(null);
          if (hadTunnelRef.current) {
            hadTunnelRef.current = false;
            setTunnelError("Tunnel disconnected");
          }
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
  }, []);

  // Persistent tRPC subscription listener for tunnel events (works even when dialog is closed)
  useEffect(() => {
    const subscription = trpc.status.stream.subscribe(undefined, {
      onData: (event: { kind: string; url?: string; error?: string }) => {
        if (event.kind === "tunnel-url" && event.url) {
          hadTunnelRef.current = true;
          setTunnelUrl(event.url);
          setTunnelError(null);
          setWebServerRunning(true);
        } else if (event.kind === "tunnel-error" && event.error) {
          hadTunnelRef.current = false;
          setTunnelUrl(null);
          setTunnelError(event.error);
          setWebServerRunning(false);
        }
      },
    });
    return () => subscription.unsubscribe();
  }, []);

  // Globe click → fresh health check, update state, then open prereq dialog
  const openDialog = useCallback(async () => {
    setTunnelError(null);
    try {
      const health = await trpc.services.health.query();
      setWebServerRunning(isServiceHealthy(health));
      if (health.tunnel && health.tunnel_url) {
        setTunnelUrl((prev) => prev ?? health.tunnel_url);
      } else if (!health.tunnel) {
        setTunnelUrl(null);
      }
    } catch {
      // continue to dialog even if check fails
    }
    setShowPrereq(true);
  }, []);

  // Prereq passed → open tunnel dialog
  const onPrereqReady = useCallback(() => {
    setShowPrereq(false);
    setShowDialog(true);
  }, []);

  const handleStopped = useCallback(() => {
    hadTunnelRef.current = false;
    setWebServerRunning(false);
    setTunnelUrl(null);
    setTunnelError(null);
    setShowDialog(false);
  }, []);

  return {
    webServerRunning,
    tunnelUrl,
    tunnelError,
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
