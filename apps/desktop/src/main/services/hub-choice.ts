/**
 * Which hub the desktop app talks to.
 *
 * `local` (the default) spawns the bundled hub, as the app always has.
 * `remote` talks to a hub at another URL with a token and spawns nothing.
 * The choice holds the remote token, so it is encrypted with the OS key store
 * (`secret-store.ts`, Electron `safeStorage`) into `~/.band/desktop-hub.enc`.
 * Only where the OS has no key store does it fall back to `~/.band/desktop-hub.json`
 * with mode 0600. A `desktop-hub.json` left by an older version is migrated to the
 * encrypted file on the first load, and deleted along with its temp copy. Both files
 * are separate from `settings.json`, which the hub owns and writes.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bandHome } from "./log.js";
import { activeSecretStore } from "./secret-store.js";

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

function encryptedChoiceFile(): string {
  return join(bandHome(), "desktop-hub.enc");
}

/** The plain-text file, its temp copy and any backup an older version or an editor left. */
function removePlainChoiceFiles(): void {
  const file = choiceFile();
  for (const path of [file, `${file}.tmp`, `${file}.bak`, `${file}~`]) {
    rmSync(path, { force: true });
  }
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

function parseStored(raw: string): HubChoice | null {
  try {
    const parsed = parseHubChoice(JSON.parse(raw) as unknown);
    return "choice" in parsed ? parsed.choice : null;
  } catch {
    return null;
  }
}

/**
 * The saved choice, or local when there is none or the files are unusable. With a key store,
 * a plain-text file from an older version moves into the encrypted file and is deleted.
 */
export function loadHubChoice(): HubChoice {
  const secrets = activeSecretStore();
  if (secrets) {
    try {
      const choice = parseStored(
        secrets.decrypt(Buffer.from(readFileSync(encryptedChoiceFile(), "utf8"), "base64")),
      );
      if (choice) {
        removePlainChoiceFiles();
        return choice;
      }
    } catch {
      // No encrypted file yet, or one this user's key cannot open: look for the old file.
    }
  }
  let legacy: HubChoice | null = null;
  try {
    legacy = parseStored(readFileSync(choiceFile(), "utf8"));
  } catch {
    legacy = null;
  }
  if (!legacy) return LOCAL_HUB_CHOICE;
  if (secrets) {
    try {
      saveHubChoice(legacy);
    } catch {
      // Keep the old file when the migration fails, so the choice is not lost.
    }
  }
  return legacy;
}

/** Write through a temp file, so a crash mid-write keeps the old choice. */
export function saveHubChoice(choice: HubChoice): void {
  mkdirSync(bandHome(), { recursive: true });
  const secrets = activeSecretStore();
  if (secrets) {
    const file = encryptedChoiceFile();
    const tmp = `${file}.tmp`;
    const blob = secrets.encrypt(JSON.stringify(choice)).toString("base64");
    writeFileSync(tmp, blob, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    removePlainChoiceFiles();
    return;
  }
  const file = choiceFile();
  const tmp = `${file}.tmp`;
  // `mode` creates the file private; the chmod covers a leftover temp file from
  // a crash, whose old mode `writeFileSync` would keep.
  writeFileSync(tmp, JSON.stringify(choice), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  // A stale encrypted copy would win at the next load if the key store came back.
  rmSync(encryptedChoiceFile(), { force: true });
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
