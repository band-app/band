import { createFileRoute } from "@tanstack/react-router";
import { getToken } from "../../lib/auth-token";
import { checkTunnelHealth, getTunnelStatus } from "../../lib/tunnel";

export const Route = createFileRoute("/api/service-health")({
  server: {
    handlers: {
      GET: async () => {
        const tunnel = getTunnelStatus();
        let tunnelHealthy = false;
        let tunnelRemoteHost: string | undefined;

        if (tunnel.running && tunnel.url) {
          const token = getToken();
          if (token) {
            const urlMatch = tunnel.url.match(/https:\/\/(.+)\.instatunnel\.my/);
            if (urlMatch) {
              const health = await checkTunnelHealth(urlMatch[1], token);
              tunnelHealthy = health.healthy;
              tunnelRemoteHost = health.remoteHost;
            }
          }
        }

        return Response.json({
          webserver: true,
          tunnel: tunnelHealthy,
          tunnel_url: tunnel.url,
          tunnel_remote_host: tunnelRemoteHost || tunnel.remoteHost,
        });
      },
    },
  },
});
