// A language server that answers `initialize` and nothing else, with Content-Length framing on
// stdio. It stands in for an extension's server in the host contract test.
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf("\r\n\r\n");
    if (sep === -1) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, sep).toString("ascii"))?.[1]);
    if (buffer.length < sep + 4 + length) return;
    const message = JSON.parse(buffer.subarray(sep + 4, sep + 4 + length).toString("utf8"));
    buffer = buffer.subarray(sep + 4 + length);
    if (message.method === "initialize") {
      const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  }
});
