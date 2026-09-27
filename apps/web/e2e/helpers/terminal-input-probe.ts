/**
 * A probe program for terminal input specs: run it in a terminal and it
 * writes a setup sequence (mouse tracking, alternate screen), prints
 * `INPUT_PROBE_READY`, and appends every byte it reads from the terminal, in
 * raw mode, to a log file.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";

/** Matches the probe's ready line, but not the typed command that starts it. */
export const INPUT_PROBE_READY = /INPUT_PROBE_READY/;

export interface InputProbe {
  /** Shell command that starts the probe. */
  command: string;
  /** Where the probe appends what it reads. */
  logPath: string;
}

/** A temp dir holding a git repo with one empty commit, for a project root. */
export function makeGitWorkdir(prefix: string, home: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env });
  return dir;
}

/** Write the probe script into `dir`; it writes `setup` to the terminal
 *  before the ready line. */
export function writeInputProbe(dir: string, setup: string): InputProbe {
  const script = join(dir, "input-probe.mjs");
  const logPath = join(dir, "input-probe.log");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      "process.stdin.setRawMode(true);",
      `process.stdout.write(${JSON.stringify(setup)});`,
      'process.stdout.write("INPUT_" + "PROBE_READY\\r\\n");',
      `process.stdin.on("data", (chunk) => appendFileSync(${JSON.stringify(logPath)}, chunk));`,
    ].join("\n"),
    "utf-8",
  );
  return { command: `${process.execPath} ${script}`, logPath };
}

/** The probe's input log with ESC written as `^[`, or "" before the first
 *  byte arrives. */
export function readInputLog(path: string): string {
  try {
    return readFileSync(path, "latin1").replaceAll("\x1b", "^[");
  } catch {
    return "";
  }
}

/** Poll until the log has grown past `baseline` characters and is unchanged
 *  between two reads 500 ms apart, i.e. the latest input (and any momentum)
 *  has finished arriving. Returns the whole log. */
export async function waitForInputToSettle(path: string, baseline = 0): Promise<string> {
  let previous: string | null = null;
  await expect
    .poll(
      () => {
        const current = readInputLog(path);
        const settled = current.length > baseline && current === previous;
        previous = current;
        return settled;
      },
      { intervals: [500], timeout: 20_000 },
    )
    .toBe(true);
  return readInputLog(path);
}
