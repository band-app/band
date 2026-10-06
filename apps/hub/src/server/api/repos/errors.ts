import { HostOfflineError, HostPathDeniedError } from "@band-app/host-api";
import { TRPCError } from "@trpc/server";
import {
  ProjectConflictError,
  ProjectInputError,
  ProjectNotFoundError,
  RepoConflictError,
  RepoInputError,
  RepoOutsideRootsError,
} from "../../errors";

/** Maps what `RepoService` throws for the caller to fix onto tRPC codes. Anything else is rethrown as it came. */
export function repoErrorToTrpc(err: unknown): unknown {
  if (err instanceof RepoOutsideRootsError) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `OUTSIDE_ROOTS: ${err.message}`,
      cause: err,
    });
  }
  if (err instanceof RepoConflictError || err instanceof ProjectConflictError) {
    return new TRPCError({ code: "CONFLICT", message: err.message });
  }
  if (err instanceof RepoInputError || err instanceof ProjectInputError) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  if (err instanceof ProjectNotFoundError) {
    return new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  if (err instanceof HostOfflineError) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  if (err instanceof HostPathDeniedError) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  return err;
}
