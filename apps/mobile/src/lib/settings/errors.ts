/**
 * How a Settings call failed, read from a tRPC client error. No React Native imports, so the
 * tests run under Node.
 */

interface ErrorLike {
  data?: { code?: string; httpStatus?: number } | null;
  message?: string;
}

function parts(err: unknown): ErrorLike {
  return (err ?? {}) as ErrorLike;
}

/** The hub is older than the app and has no such procedure. */
export function isMissingProcedure(err: unknown): boolean {
  const e = parts(err);
  return e.data?.code === "NOT_FOUND" && /no .*procedure/i.test(e.message ?? "");
}

/** The token is not allowed to make this call (a non-admin token on an admin procedure). */
export function isForbidden(err: unknown): boolean {
  return parts(err).data?.code === "FORBIDDEN";
}

export const UPDATE_THE_HUB = "This hub is older than the app. Update the hub to use this.";

export function errorText(err: unknown): string {
  if (isMissingProcedure(err)) return UPDATE_THE_HUB;
  return err instanceof Error ? err.message : String(err);
}
