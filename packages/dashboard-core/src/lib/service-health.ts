export interface ServiceHealth {
  webserver: boolean;
  tunnel: boolean;
  tunnel_url: string | null;
  tunnel_remote_host: string | null;
}

/**
 * Determine whether the globe button should show as active (green).
 *
 * When a tunnel subdomain is configured, both the web server AND the tunnel
 * must be healthy.  Without a subdomain the web server alone is enough.
 */
export function isServiceHealthy(health: ServiceHealth, tunnelSubdomain?: string | null): boolean {
  if (!health.webserver) return false;
  if (tunnelSubdomain) return health.tunnel;
  return true;
}
