/**
 * Thrown by a `Host` method its implementation has no code for yet. Only
 * methods nothing calls through the host may do this.
 */
export class HostNotImplementedError extends Error {
  constructor(hostId: string, method: string) {
    super(`Host "${hostId}" does not implement ${method} yet`);
    this.name = "HostNotImplementedError";
  }
}

/**
 * A remote host refused a path because it lies outside the roots the host
 * serves. A local host has no such policy and never throws this.
 */
export class HostPathDeniedError extends Error {
  readonly path: string;
  constructor(path: string, message?: string) {
    super(message ?? `Path ${JSON.stringify(path)} is outside the host's roots`);
    this.name = "HostPathDeniedError";
    this.path = path;
  }
}

/** A remote host has no live link to the hub, so the call could not be sent or its answer was lost. */
export class HostOfflineError extends Error {
  constructor(hostId: string, detail?: string) {
    super(`Host "${hostId}" is offline${detail ? `: ${detail}` : ""}`);
    this.name = "HostOfflineError";
  }
}

/** A call to a remote host did not answer within its time limit. */
export class HostTimeoutError extends Error {
  constructor(hostId: string, method: string, ms: number) {
    super(`Host "${hostId}" did not answer ${method} within ${ms} ms`);
    this.name = "HostTimeoutError";
  }
}
