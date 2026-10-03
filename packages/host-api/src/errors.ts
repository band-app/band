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
