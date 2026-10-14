/**
 * Tells the hub what this UI is doing, so the branch-status poller can slow down.
 *
 *   focused && !onBattery  → "active"      (5 s git / 30 s CI)
 *   focused &&  onBattery  → "idle"        (30 s git / 3 min CI)
 *  !focused && !onBattery  → "idle"
 *  !focused &&  onBattery  → "background"  (60 s git / 10 min CI)
 *
 * Each page load names itself with a random client id. The hub keeps the most active live client
 * and drops one that stops reporting, so the report repeats every minute while the page is open.
 */

import { hubFetch, hubUrl } from "./hub-config";
import { getPowerState, type PowerState, subscribePowerState } from "./power-state";
import { trpc } from "./trpc-client";

type ActivityLevel = "active" | "idle" | "background";

const KEEP_ALIVE_MS = 60_000;
const DEBOUNCE_MS = 250;

export function computeActivity(s: PowerState): ActivityLevel {
  if (s.focused && !s.onBattery) return "active";
  if (!s.focused && s.onBattery) return "background";
  return "idle";
}

let started = false;

export function startActivityReporter(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  // `crypto.randomUUID` is missing on a plain-http page that is not localhost (a phone on a LAN URL).
  const clientId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const send = () => {
    debounce = null;
    // Best effort: the next change or keep-alive tries again.
    trpc.services.setActivity
      .mutate({ activity: computeActivity(getPowerState()), clientId })
      .catch(() => {});
  };
  const schedule = () => {
    if (debounce) return;
    debounce = setTimeout(send, DEBOUNCE_MS);
  };

  subscribePowerState(schedule);
  setInterval(send, KEEP_ALIVE_MS);
  // A normal request is often cancelled while the page unloads; `keepalive` lets this one finish.
  // The hub drops the client after its expiry if this never arrives.
  window.addEventListener("pagehide", () => {
    hubFetch(hubUrl("/trpc/services.releaseActivity"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId }),
      keepalive: true,
    }).catch(() => {});
  });
  send();
}
