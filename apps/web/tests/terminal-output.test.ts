import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

// `terminal.output` returns the last 100 000 characters a terminal printed.
// The pool keeps that tail as a list of output chunks and trims it only when
// read, so these tests print far more than the cap in many chunks and check
// the tail is exact: the right length, contiguous, and ending at the end.

const TOKEN = "terminal-output-token";
const PROJECT = "outputproj";
const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
const MAX_OUTPUT_CHARS = 100_000;

let tmpHome: string;
let server: ServerHandle;

async function readOutput(terminalId: string, lines?: number): Promise<Response> {
  return trpcQuery(server.url, "terminal.output", { terminalId, lines }, TOKEN);
}

async function outputText(terminalId: string, lines?: number): Promise<string> {
  const res = await readOutput(terminalId, lines);
  expect(res.status).toBe(200);
  return (await trpcData<{ output: string }>(res)).output;
}

beforeAll(async () => {
  tmpHome = createTmpHome("band-terminal-output-");
  const worktree = join(tmpHome, PROJECT);
  mkdirSync(worktree, { recursive: true });
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: worktree,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: worktree }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

afterAll(async () => {
  await server?.close();
  rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("terminal.output", () => {
  it("returns exactly the last 100 000 characters after output well past the cap", async () => {
    const terminalId = randomUUID();
    const created = await trpcMutate(
      server.url,
      "terminal.create",
      { workspaceId: WORKSPACE_ID, id: terminalId },
      TOKEN,
    );
    expect(created.status).toBe(200);
    const socket = await TerminalSocket.open(server, {
      workspaceId: WORKSPACE_ID,
      terminalId,
      token: TOKEN,
    });
    // ~290 KB over many PTY chunks, then a marker the shell computes so the
    // echoed command line can't match it.
    socket.type("seq 1 50000; echo OUTPUT_DONE_$((40+2))\r");
    await waitFor(
      async () => ((await outputText(terminalId)).includes("OUTPUT_DONE_42") ? true : undefined),
      {
        label: "marker in terminal.output",
      },
    );
    await socket.close();

    const output = await outputText(terminalId);
    expect(output).toHaveLength(MAX_OUTPUT_CHARS);
    // Every full `seq` line in the tail follows the one before it, up to 50000:
    // no chunk was dropped from the middle or reordered.
    const numbers = output
      .split("\r\n")
      .slice(1)
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
    expect(numbers.length).toBeGreaterThan(10_000);
    expect(numbers.at(-1)).toBe(50_000);
    numbers.forEach((n, i) => {
      if (i > 0) expect(n).toBe(numbers[i - 1] + 1);
    });

    // `lines` slices the same tail.
    const lastLines = await outputText(terminalId, 3);
    expect(output.endsWith(lastLines)).toBe(true);
    expect(lastLines.split("\n")).toHaveLength(3);
  });

  it("answers 404 for a terminal that doesn't exist", async () => {
    const res = await readOutput(randomUUID());
    expect(res.status).toBe(404);
  });

  it("refuses a request without the token", async () => {
    const input = encodeURIComponent(JSON.stringify({ terminalId: randomUUID() }));
    const res = await fetch(`${server.url}/trpc/terminal.output?input=${input}`);
    expect(res.status).toBe(401);
  });
});
