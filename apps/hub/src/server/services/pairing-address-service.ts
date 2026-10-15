/**
 * The addresses a pairing link may use: `BAND_PUBLIC_URL`, this machine's network interfaces
 * and the custom addresses saved in settings. Only this service writes
 * `settings.pairingAddresses`, and it re-checks every stored entry on read.
 */

import { networkInterfaces } from "node:os";
import { SettingsQueries } from "../infra/db/queries/settings";
import {
  listPairingInterfaces,
  normalizeCustomAddress,
  type PairingInterface,
} from "./_utils/pairing-addresses";

const MAX_CUSTOM_ADDRESSES = 20;

export class InvalidPairingAddressError extends Error {
  constructor() {
    super("Enter an http:// or https:// URL, for example https://band.example.ts.net");
    this.name = "InvalidPairingAddressError";
  }
}

export interface PairingAddresses {
  publicUrl: string | null;
  interfaces: PairingInterface[];
  custom: string[];
}

export class PairingAddressService {
  constructor(private readonly settings: SettingsQueries = new SettingsQueries()) {}

  /** Read on every call, so Refresh sees a network that changed. */
  list(): PairingAddresses {
    const raw = process.env.BAND_PUBLIC_URL?.trim();
    const port = Number(process.env.BAND_PORT) || 0;
    return {
      publicUrl: raw ? normalizeCustomAddress(raw) : null,
      interfaces: port ? listPairingInterfaces(networkInterfaces(), port) : [],
      custom: this.custom(),
    };
  }

  /** Saves an http(s) origin. It is not probed: the hub can't tell what another device reaches. */
  add(input: string): { url: string; custom: string[] } {
    const url = normalizeCustomAddress(input);
    if (!url) throw new InvalidPairingAddressError();
    const current = this.custom();
    const custom = current.includes(url) ? current : [...current, url].slice(-MAX_CUSTOM_ADDRESSES);
    this.settings.save({ pairingAddresses: custom });
    return { url, custom };
  }

  remove(url: string): { custom: string[] } {
    const custom = this.custom().filter((u) => u !== url);
    this.settings.save({ pairingAddresses: custom });
    return { custom };
  }

  private custom(): string[] {
    return (this.settings.load().pairingAddresses ?? []).filter(
      (u) => normalizeCustomAddress(u) === u,
    );
  }
}

export const pairingAddressService = new PairingAddressService();
