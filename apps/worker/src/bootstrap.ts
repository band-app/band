import { httpUrl, type WorkerConfig } from "./config.ts";

export interface BootstrapRequest {
  hubUrl: WorkerConfig["hubUrl"];
  bootstrapToken: string;
  workerId: string;
  name: string | undefined;
}

/**
 * Trades a one-time bootstrap token for a session token.
 *
 * TODO(2.3): the hub endpoint lands in step 2.3. The path and bodies below are
 * this worker's side of the contract: `POST /api/workers/bootstrap` with
 * `{ token, workerId, name? }`, answered by `{ sessionToken }`. Change them
 * here, and only here, if the hub settles on something else.
 */
export async function exchangeBootstrapToken(req: BootstrapRequest): Promise<string> {
  const res = await fetch(httpUrl(req.hubUrl, "/api/workers/bootstrap"), {
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
  const body = (await res.json()) as { sessionToken?: unknown };
  if (typeof body.sessionToken !== "string" || body.sessionToken === "") {
    throw new Error("the hub's bootstrap answer has no sessionToken");
  }
  return body.sessionToken;
}
