export interface ServiceHealth {
  webserver: boolean;
  tunnel: boolean;
  tunnel_url: string | null;
}

/**
 * Determine whether the globe button should show as active (green).
 * Both the web server AND the tunnel must be healthy.
 */
export function isServiceHealthy(health: ServiceHealth): boolean {
  return health.webserver && health.tunnel;
}
