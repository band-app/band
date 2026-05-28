import { type TunnelClient, tunnelClient } from "../infra/tunnels/tunnel-client";

/**
 * Business logic for the cloudflared tunnel.
 *
 * Thin wrapper over `TunnelClient` — there's no orchestration beyond
 * resolving the port the web server is actually bound to, but keeping the
 * service layer in place mirrors the rest of the 3-tier refactor (issue
 * #517) and gives a stable shape for future work (rate-limiting, multi-
 * tunnel support, auto-restart, etc.).
 */
export class TunnelService {
  constructor(private readonly client: TunnelClient = tunnelClient) {}

  /**
   * Start the tunnel pointed at the web server's bound port. Idempotent —
   * if the tunnel is already running, the existing URL is re-emitted to
   * SSE listeners and the call returns immediately.
   *
   * Reads `BAND_PORT` from `process.env`; that value is stamped by the
   * server boot path (`start-server.ts`) once `listenWithFallback` knows
   * which port actually got claimed. The default `3456` matches the
   * historical value used by the desktop shell.
   */
  async start(): Promise<void> {
    const port = parseInt(process.env.BAND_PORT || "3456", 10);
    await this.client.start({ port });
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  getStatus(): { running: boolean; url: string | null } {
    return this.client.getStatus();
  }
}

export const tunnelService = new TunnelService();
