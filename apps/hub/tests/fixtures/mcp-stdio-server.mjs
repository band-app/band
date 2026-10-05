// A tiny stdio MCP server for the stdio relay tests (plan step 4.4). It runs on the worker as the process
// the hub's proxy talks to. `whoami` reports the process id and working directory, `env_hash` reports a
// SHA-256 of an environment variable (so a test can prove a secret arrived without the secret being echoed),
// and `echo`, `add` and `write_note` give the tool filters something to allow and refuse.

import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const text = (value) => ({ content: [{ type: "text", text: String(value) }] });
const server = new McpServer({ name: "stdio-stub", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Returns its input",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text: input }) => text(`echo:${input}`),
);
server.registerTool(
  "add",
  {
    description: "Adds two numbers",
    inputSchema: { a: z.number(), b: z.number() },
    annotations: { readOnlyHint: true },
  },
  async ({ a, b }) => text(a + b),
);
server.registerTool(
  "write_note",
  {
    description: "Writes a note",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: false },
  },
  async ({ text: input }) => text(`wrote:${input}`),
);
server.registerTool(
  "whoami",
  { description: "The process id and working directory", annotations: { readOnlyHint: true } },
  async () => text(JSON.stringify({ pid: process.pid, cwd: process.cwd() })),
);
server.registerTool(
  "env_hash",
  {
    description: "SHA-256 of an environment variable",
    inputSchema: { name: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ name }) =>
    text(createHash("sha256").update(process.env[name] ?? "").digest("hex")),
);

await server.connect(new StdioServerTransport());
