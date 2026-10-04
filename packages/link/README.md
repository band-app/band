# @band-app/link

One multiplexed WebSocket between a worker and the hub. Nothing in the hub or a worker uses it yet.

It carries four things on one socket: a versioned handshake, JSON-RPC 2.0 calls in both directions, numbered byte channels with credit-based flow control, and heartbeats. After a dropped socket the client dials again and resumes where each channel stopped.

```ts
import { createHash, timingSafeEqual } from "node:crypto";

// hub
const digest = (t: string) => createHash("sha256").update(t).digest();
const server = new LinkServer({
  authenticate: (hello) => ({ ok: timingSafeEqual(digest(hello.token), digest(expected)) }),
});
server.on("session", (s) => s.handle("ping", () => "pong"));
await server.listen(8080); // or call server.handleConnection(ws) from your own ws server, created with maxPayload set (MAX_MESSAGE_BYTES). Use wss:// for any non-loopback hub, because the hello carries the token.

// worker
const client = new LinkClient({ url: "ws://hub/", token, hello: { workerId, buildId, mode: "attached", capabilities: [], labels: {}, roots: [], agents: [] } });
await client.connect();
const ch = client.session.openChannel("pty", { id: "t1" });
await ch.send(Buffer.from("ls\n")); // waits for credit
```

## Wire format

### Handshake (text frames, JSON)

The first frame from the client is `hello`. The server answers with exactly one of `ready`, `mismatch` or `rejected`. After `ready`, text frames are JSON-RPC and binary frames are channel frames.

| Message | Direction | Fields |
| --- | --- | --- |
| `hello` | client to server | `protocol`, `workerId`, `token`, optional `sessionToken`, `buildId`, `mode` (`attached` or `ephemeral`), `capabilities`, `labels`, `roots`, `agents`, optional `resume` |
| `ready` | server to client | `sessionToken`, `heartbeatMs`, `resumed`, optional `resume` |
| `mismatch` | server to client | `need`: the protocol version the server speaks |
| `rejected` | server to client | `reason` |

`resume` maps a channel id to the highest sequence number the sender has received on it. A `hello` carries `resume` (even `{}`) only when the client wants to continue an earlier session. Without it the server discards any session it still holds for that `workerId`. `ready.resumed` is false when the server has no session to continue, and the client then fails every channel it had open. The server calls the `authenticate` callback for every `hello`, resumes included, and passes the live session for that `workerId` as a second argument. The hub must check that the credential owns that `workerId`, because a `hello` for an existing worker takes over its session. After `mismatch` or `rejected` the client stops redialing.

### Control (text frames, JSON-RPC 2.0)

Either side sends requests, responses and notifications. Error codes: `-32601` unknown method, `-32603` handler threw, `-32800` cancelled by the caller. A request has a timeout (30 s by default) and takes an `AbortSignal`. On timeout or abort the caller sends the `link.cancel` notification, and the callee's handler sees its `signal` abort. A socket drop rejects every pending call with `LinkClosedError`.

Methods the link reserves:

| Method | Kind | Params |
| --- | --- | --- |
| `link.heartbeat` | notification | none |
| `link.cancel` | notification | `{ id }` of the request to cancel |
| `link.open` | notification | `{ chan, name, meta }`, opens a channel |

### Channel frames (binary frames)

```
 0       1               5               9
 +-------+---------------+---------------+------------------+
 | kind  | chan (u32 BE) | seq (u32 BE)  | payload          |
 +-------+---------------+---------------+------------------+
```

| kind | code | seq | payload |
| --- | --- | --- | --- |
| `data` | 0 | next sequence number, from 1 | bytes, at most 16 KiB |
| `end` | 1 | next sequence number | empty |
| `credit` | 2 | highest sequence the receiver has consumed | cumulative bytes consumed, float64 BE |
| `reset` | 3 | 0 | UTF-8 reason |

The client allocates odd channel ids and the server even ones. `data` and `end` share one sequence counter per direction. The receiver drops a frame whose sequence is at or below the last it accepted, and closes the socket on a gap.

Flow control. A sender may have at most one window (256 KiB by default, `window` option) of `data` bytes written and not yet consumed. The receiver is a pull reader (`for await`), and it reports consumption in `credit` frames. Credit is cumulative, so a lost `credit` frame costs nothing. A sender that is out of credit queues frames, and the promise from `send()` stays pending until they are written.

Resume. A sender keeps each frame until a `credit` frame covers its sequence. After reconnect both sides exchange `resume` maps, send the frames after the peer's last received sequence, and send a fresh `credit` for every channel. A channel the peer's map lacks is announced again with `link.open` and replayed from 1. Each frame arrives exactly once.

### Liveness

Each side sends `link.heartbeat` every `heartbeatMs` (15 s by default, chosen by the server in `ready`). A side that received no frame for three intervals emits `lost` and terminates the socket. The server also sends a WebSocket ping every interval, which keeps idle tunnels (Cloudflare closes them after about 100 s) open.

The server keeps a session with no socket for `resumeTtlMs` (5 minutes by default), then drops it and fails its channels.

## Tests

`pnpm --filter @band-app/link test` runs `node:test` suites against real WebSocket servers on random ports, including a chaos test that kills the socket every 150 KB of a 3 MB stream.
