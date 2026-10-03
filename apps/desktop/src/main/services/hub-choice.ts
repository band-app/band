/**
 * Which hub the desktop app talks to, kept in `~/.band/desktop-hub.json`.
 *
 * `local` (the default) spawns the bundled hub, as the app always has.
 * `remote` talks to a hub at another URL with a token and spawns nothing.
 * The file holds the remote token, so it is written with mode 0600. It is
 * separate from `settings.json`, which the hub owns and writes.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bandHome } from "./log.js";

export type HubChoice = { mode: "local" } | { mode: "remote"; url: string; token: string };

export const LOCAL_HUB_CHOICE: HubChoice = { mode: "local" };

/** What the renderer sees. The token never leaves the main process except through `hub-config`. */
export interface HubChoiceView {
  mode: "local" | "remote";
  url: string;
  hasToken: boolean;
}

/** A token must be valid in a WebSocket subprotocol, like `hub-config.ts` in the UI requires. */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;

function choiceFile(): string {
  return join(bandHome(), "desktop-hub.json");
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/**
 * The origin of a remote hub URL, or an error message. The bundled UI is a
 * secure context, and Chromium blocks plain `http:` and `ws:` requests from
 * one unless the host is loopback, so other hosts need https.
 */
export function parseRemoteUrl(raw: string): { origin: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "Enter a full URL, for example https://hub.example.com" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "The hub URL must start with https:// or http://" };
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return { error: "A hub on another machine needs an https:// URL" };
  }
  return { origin: url.origin };
}

/** Validates what the picker submits. */
export function parseHubChoice(input: unknown): { choice: HubChoice } | { error: string } {
  if (!input || typeof input !== "object") return { error: "Invalid hub settings" };
  const { mode, url, token } = input as Record<string, unknown>;
  if (mode === "local") return { choice: LOCAL_HUB_CHOICE };
  if (mode !== "remote") return { error: "Invalid hub mode" };
  if (typeof url !== "string") return { error: "Enter the hub URL" };
  const parsed = parseRemoteUrl(url);
  if ("error" in parsed) return parsed;
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token.trim())) {
    return { error: "Enter the hub's token (letters, digits and . _ ~ - only)" };
  }
  return { choice: { mode: "remote", url: parsed.origin, token: token.trim() } };
}

/** The saved choice, or local when there is none or the file is unusable. */
export function loadHubChoice(): HubChoice {
  try {
    const raw = JSON.parse(readFileSync(choiceFile(), "utf8")) as unknown;
    const parsed = parseHubChoice(raw);
    return "choice" in parsed ? parsed.choice : LOCAL_HUB_CHOICE;
  } catch {
    return LOCAL_HUB_CHOICE;
  }
}

/** Write through a temp file, so a crash mid-write keeps the old choice. */
export function saveHubChoice(choice: HubChoice): void {
  const file = choiceFile();
  mkdirSync(bandHome(), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(choice), { mode: 0o600 });
  renameSync(tmp, file);
}

export function viewHubChoice(choice: HubChoice): HubChoiceView {
  return choice.mode === "remote"
    ? { mode: "remote", url: choice.url, hasToken: true }
    : { mode: "local", url: "", hasToken: false };
}

/**
 * Ask a hub who it is, with the token. Used before saving a remote choice so a
 * wrong URL or token fails in the picker, not as a dashboard full of errors.
 */
export async function checkRemoteHub(
  url: string,
  token: string,
  timeoutMs = 5_000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${url}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "The hub rejected the token" };
    }
    if (!res.ok) return { ok: false, error: `The hub answered with HTTP ${res.status}` };
    const body = (await res.json()) as { app?: unknown };
    if (body.app !== "band-web-server") return { ok: false, error: "That URL is not a Band hub" };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the hub at that URL" };
  }
}
