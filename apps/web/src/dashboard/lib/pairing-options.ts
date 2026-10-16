/**
 * The address choices in the Connect details dialog. The order is the public URL
 * (`BAND_PUBLIC_URL`), this page's origin, the hub machine's interfaces as the hub ranks them
 * (bridges last), then custom addresses. The default is the public URL when set, else the
 * page origin, so a bridge is never preselected.
 */

export interface PairingInterfaceInfo {
  url: string;
  label: string;
  kind: "tailscale" | "ipv4" | "ipv6" | "bridge";
}

export interface PairingOption {
  /** The address the link uses, an origin with no trailing slash. */
  url: string;
  label: string;
  source: "public" | "page" | "interface" | "custom";
  /** For an interface, how the hub ranked it. Bridges are listed last and never preselected. */
  kind?: PairingInterfaceInfo["kind"];
}

export function buildPairingOptions(input: {
  publicUrl: string | null;
  pageOrigin: string;
  interfaces: readonly PairingInterfaceInfo[];
  custom: readonly string[];
}): PairingOption[] {
  const options: PairingOption[] = [];
  const seen = new Set<string>();
  const add = (option: PairingOption) => {
    if (seen.has(option.url)) return;
    seen.add(option.url);
    options.push(option);
  };
  if (input.publicUrl) {
    add({ url: input.publicUrl, label: `Public URL (${input.publicUrl})`, source: "public" });
  }
  add({ url: input.pageOrigin, label: `This page (${input.pageOrigin})`, source: "page" });
  for (const i of input.interfaces) {
    add({
      url: i.url,
      label: i.kind === "bridge" ? `${i.label} · virtual network` : i.label,
      source: "interface",
      kind: i.kind,
    });
  }
  for (const url of input.custom) add({ url, label: `Custom (${url})`, source: "custom" });
  return options;
}

/** The remembered choice when it is still offered, else the public URL, else the page origin. */
export function pickDefaultAddress(options: readonly PairingOption[], remembered?: string | null) {
  const kept = remembered ? options.find((o) => o.url === remembered) : undefined;
  return (
    kept ??
    options.find((o) => o.source === "public") ??
    options.find((o) => o.source === "page") ??
    options[0]
  );
}

export function pairingLink(address: string, code: string): string {
  return `${address.replace(/\/+$/, "")}/?pair=${encodeURIComponent(code)}`;
}
