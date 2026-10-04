import { execFile } from "node:child_process";
import { extractVersion } from "@band-app/environment";
import { prependBinDirs } from "./path";

/** The tools a project's `requires` can name, with the binary and arguments that print each one's version. */
const PROBES: ReadonlyArray<{ tool: string; bin: string; args: string[] }> = [
  { tool: "node", bin: "node", args: ["--version"] },
  { tool: "python", bin: "python3", args: ["--version"] },
  { tool: "go", bin: "go", args: ["version"] },
  { tool: "pnpm", bin: "pnpm", args: ["--version"] },
  { tool: "uv", bin: "uv", args: ["--version"] },
  { tool: "docker", bin: "docker", args: ["--version"] },
  { tool: "git", bin: "git", args: ["--version"] },
];

const PROBE_TIMEOUT_MS = 5_000;

function versionOf(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        env: { ...process.env, PATH: prependBinDirs(process.env.PATH) },
        timeout: PROBE_TIMEOUT_MS,
      },
      (err, stdout, stderr) => resolve(err ? null : extractVersion(`${stdout}\n${stderr}`)),
    );
  });
}

/**
 * Runs each tool's version command on this machine, in parallel. A tool that
 * is not installed, fails or prints no version is left out of the result.
 */
export async function probeTools(): Promise<Record<string, string>> {
  const found = await Promise.all(
    PROBES.map(async ({ tool, bin, args }) => [tool, await versionOf(bin, args)] as const),
  );
  const tools: Record<string, string> = {};
  for (const [tool, version] of found) if (version !== null) tools[tool] = version;
  return tools;
}
