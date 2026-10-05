import type { Environment } from "./schema.ts";

export type EnvironmentScript = "setup" | "teardown";

/**
 * The shell text a worktree runs for `script`, or `null` when the
 * environment has none. Setup is `install` then `start`, and it stops at the
 * first one that fails. Teardown is `teardown`.
 */
export function scriptFor(environment: Environment, script: EnvironmentScript): string | null {
  if (script === "teardown") return environment.teardown ?? null;
  const { install, start } = environment;
  if (install && start) return `{\n${install}\n} && {\n${start}\n}`;
  return install ?? start ?? null;
}
