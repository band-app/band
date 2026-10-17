/**
 * Sends uncaught errors and unhandled promise rejections to the desktop app's
 * log through a narrow `report_renderer_error` call. In a plain browser there
 * is no bridge, so nothing is sent and the errors stay in the console.
 */

import { getElectronBridge } from "./desktop-ipc";

interface ErrorTarget {
  // oxlint-disable-next-line typescript/no-explicit-any -- accepts both `Window` and a plain test double
  addEventListener(type: any, listener: any): void;
  // oxlint-disable-next-line typescript/no-explicit-any -- accepts both `Window` and a plain test double
  removeEventListener(type: any, listener: any): void;
  location?: { href: string };
}

type Send = (report: { kind: string; message: string; stack: string; url: string }) => void;

function describe(value: unknown): { message: string; stack: string } {
  if (value instanceof Error)
    return { message: value.message || value.name, stack: value.stack ?? "" };
  if (typeof value === "string") return { message: value, stack: "" };
  try {
    return { message: JSON.stringify(value) ?? String(value), stack: "" };
  } catch {
    return { message: String(value), stack: "" };
  }
}

export function installRendererErrorReporting(
  target: ErrorTarget,
  send: Send | null = defaultSend(),
): () => void {
  if (!send) return () => {};
  const url = () => target.location?.href ?? "";
  const emit = (kind: string, value: unknown) => {
    try {
      send({ kind, ...describe(value), url: url() });
    } catch {
      // Reporting must never throw back into the page.
    }
  };
  const onError = (event: { error?: unknown; message?: string }) =>
    emit("error", event.error ?? event.message ?? "Unknown error");
  const onRejection = (event: { reason?: unknown }) => emit("unhandledrejection", event.reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

function defaultSend(): Send | null {
  const bridge = getElectronBridge();
  if (!bridge) return null;
  return (report) => {
    void bridge.invoke("report_renderer_error", report).catch(() => {});
  };
}
