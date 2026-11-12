/** Checks shared by the provisioning settings and the worker profiles. */

import { TRPCError } from "@trpc/server";

/** A start command is a relative path inside the repo. */
export function checkStartCommand(command: string): string {
  const ok =
    /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(command) &&
    !command.split("/").some((part) => part === ".." || part === "") &&
    command.length <= 200;
  if (!ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The start command must be a relative path inside the repo, such as band/provision.sh.",
    });
  }
  return command;
}

/** Refuses a repo URL that would put a secret on a command line or send one in cleartext. */
export function checkRepoUrl(url: string): void {
  if (/\s/.test(url)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The repo URL must not contain spaces." });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // An scp-like remote or a path.
  }
  if (parsed.username || parsed.password) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The repo URL must not hold a username or password. Add a git credential to the vault.",
    });
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The repo URL must use https." });
  }
}
