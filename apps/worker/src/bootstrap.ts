import { httpUrl, type WorkerConfig } from "./config.ts";

export interface BootstrapRequest {
  hubUrl: WorkerConfig["hubUrl"];
  bootstrapToken: string;
  /** The id the hub issued, when the worker was told it. Without one the hub names the worker. */
  workerId: string | undefined;
  name: string | undefined;
}

export interface BootstrapResult {
  sessionToken: string;
  /** The worker id the session token is bound to. */
  workerId: string;
}

/**
 * Trades a one-time bootstrap token for a session token: `POST
 * /api/workers/exchange` with `{ token, workerId?, name? }`, answered by
 * `{ sessionToken, workerId }`. The token is bound to the host id the hub
 * issued it for, and that id is the worker id.
 */
export async function exchangeBootstrapToken(req: BootstrapRequest): Promise<BootstrapResult> {
  const res = await fetch(httpUrl(req.hubUrl, "/api/workers/exchange"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: req.bootstrapToken, workerId: req.workerId, name: req.name }),
    // A redirect would re-send the token to another host.
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // The status only. The response and the request both hold secrets.
    throw new Error(`the hub refused the bootstrap token (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { sessionToken?: unknown; workerId?: unknown };
  if (typeof body.sessionToken !== "string" || body.sessionToken === "") {
    throw new Error("the hub's bootstrap answer has no sessionToken");
  }
  if (typeof body.workerId !== "string" || body.workerId === "") {
    throw new Error("the hub's bootstrap answer has no workerId");
  }
  return { sessionToken: body.sessionToken, workerId: body.workerId };
}
