# @band-app/host-remote

`RemoteHost` implements the `Host` interface from `@band-app/host-api` over a worker's link session. The hub keeps one per worker in its `HostRegistry`, so a service calls `workspace.host.fs.readFile(...)` the same way for the local machine and a worker.

Each method is one call, or one channel, on the session. The method and channel names are the ones `apps/worker` registers (`fs.stat`, `git.exec`, `pty.attach`, `acp.spawn`, and so on).

```ts
const host = new RemoteHost({
  id: workerId,
  session: () => linkServer.getSession(workerId),
});
linkServer.on("session", (session) => host.attachSession(session));
```

`session` is read on every call, because a restarted worker gets a new session. `attachSession` routes the worker's `pty.exit`, `acp.exit` and `scripts.exited` notifications to the host, and reports the shells and agents of a session that ended for good as exited.

## Errors

| Cause | Error |
| --- | --- |
| No attached session | `HostOfflineError` |
| No answer within the call's limit | `HostTimeoutError` |
| A path outside the worker's roots | `HostPathDeniedError` (`path` holds the path) |
| A failure on the worker | `Error` with the worker's message, and `code` set when the message starts with an errno such as `ENOENT:` |
| A call the caller aborts | `AbortError` |

The default limit is 30 seconds. Calls that clone, copy, scan or wait on a process have longer limits, listed in `src/rpc.ts`. `exec` uses its own `timeoutMs` plus 5 seconds when it has one.

## Data

A result under 256 KiB comes back in the response. A larger one arrives on a channel the worker opens first, and `RemoteHost` reads it to the end. `fs.writeFile` sends data over 256 KiB on a channel the host opens, because a link message may not exceed 1 MiB.

A stream (`fs.watch`, `search.stream`, `fs.readStream`, `acp.spawn` output) ends the worker's source when the consumer leaves the loop early or aborts. A language server's `Duplex` is the exception: a reader may stop and a later one resume, as with a local server.

## Tests

The host contract suite runs against `RemoteHost` in `apps/worker/tests/host-remote-contract.test.ts`, with a real worker on a loopback link. `host-remote-errors.test.ts` there covers the errors and the large-file path. `apps/hub/tests/remote-host.test.ts` runs a real hub and the real `band-worker` binary.
