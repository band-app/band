/**
 * Devices screen helpers: which tokens are devices, the copy of each confirm, and the pairing
 * link. Pure, so the tests run under Node.
 */

import { relativeTime } from "@band-app/client/merge";

export interface TokenLike {
  id: string;
  kind: string;
  label: string;
  admin: boolean;
  state: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export function devicesOf<T extends TokenLike>(tokens: readonly T[]): T[] {
  return tokens.filter((t) => t.kind === "device");
}

export interface RevokePrompt {
  title: string;
  message: string;
  confirm: string;
  /** Revoking the token the app is signed in with signs this phone out. */
  own: boolean;
}

export function revokePrompt(device: TokenLike, currentTokenId: string | null): RevokePrompt {
  const name = device.label || device.id;
  if (device.id === currentTokenId) {
    return {
      title: `Revoke ${name}?`,
      message:
        "This is the token this phone is signed in with. Revoking it signs you out of this hub here, and you will need a new pairing link to come back.",
      confirm: "Revoke and sign out",
      own: true,
    };
  }
  return {
    title: `Revoke ${name}?`,
    message: "Revoking signs this device out and removes it from the list.",
    confirm: "Revoke",
    own: false,
  };
}

/** The hub's own shared token cannot be revoked. */
export function canRevoke(device: TokenLike): boolean {
  return device.state === "active" && device.id !== "shared";
}

export function deviceDetail(device: TokenLike, now = Date.now()): string {
  const used =
    device.lastUsedAt == null
      ? "never used"
      : `used ${relativeTime(new Date(device.lastUsedAt).toISOString(), now)}`;
  return `${device.admin ? "Admin" : "Standard"} · ${device.state} · ${used}`;
}

/** The link a new device opens: the same shape as the web's Connect details. */
export function pairingLink(address: string, code: string): string {
  return `${address.replace(/\/+$/, "")}/?pair=${encodeURIComponent(code)}`;
}
