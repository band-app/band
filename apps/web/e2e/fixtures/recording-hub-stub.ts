import { createServer } from "node:http";

export interface RecordedRequest {
  authorization?: string;
  wsProtocol?: string;
  url: string;
}

export interface RecordingHubStub {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

/**
 * A stand-in for "some other hub": it allows every origin, answers 401 and
 * records the credentials each request carried, including WebSocket upgrades.
 * It lets a test see exactly what the UI sends to a hub it was not set up for.
 */
export function startRecordingHubStub(port: number): Promise<RecordingHubStub> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": req.headers.origin ?? "*",
      "Access-Control-Allow-Headers": "authorization, content-type, last-event-id",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    requests.push({ authorization: req.headers.authorization, url: req.url ?? "" });
    res.writeHead(401, cors);
    res.end("Unauthorized");
  });
  server.on("upgrade", (req, socket) => {
    const protocol = req.headers["sec-websocket-protocol"];
    requests.push({
      wsProtocol: typeof protocol === "string" ? protocol : undefined,
      url: req.url ?? "",
    });
    socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
