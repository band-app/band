/**
 * The addresses another device could reach this hub on, for the Connect details picker. The
 * rules follow Orca's pairing picker: drop internal, IPv6 link-local and proxy fake-IP
 * addresses, put Tailscale first, then IPv4, then IPv6, and rank bridge and virtual interfaces
 * last. A bridge is listed but never chosen as a default.
 */

import type { NetworkInterfaceInfo } from "node:os";

export type PairingAddressKind = "tailscale" | "ipv4" | "ipv6" | "bridge";

export interface PairingInterface {
  /** The IP address, without brackets. */
  address: string;
  /** The interface name, such as `en0` or `tailscale0`. */
  name: string;
  kind: PairingAddressKind;
  /** The link base: `http://<address>:<port>`, with an IPv6 address in brackets. */
  url: string;
  /** `<address> (<ifname>)` */
  label: string;
}

/** Interface names of bridges and virtual networks: container, VM and overlay networks. */
const BRIDGE_NAME =
  /^(docker|br-|virbr|vmnet|vboxnet|veth|lxcbr|cni|flannel|cali|bridge)|vethernet|vmware|virtualbox|hyper-v|wsl/i;

function ipv4Octets(address: string): [number, number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

/** Tailscale's CGNAT range, 100.64.0.0/10. */
function isTailscale(address: string): boolean {
  const o = ipv4Octets(address);
  return o !== null && o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

/** Fake IPs that proxy tools hand out, 198.18.0.0/15. */
function isProxyFakeIp(address: string): boolean {
  const o = ipv4Octets(address);
  return o !== null && o[0] === 198 && (o[1] === 18 || o[1] === 19);
}

function isLinkLocalV6(address: string): boolean {
  return /^fe[89ab][0-9a-f]:/i.test(address);
}

const RANK: Record<PairingAddressKind, number> = { tailscale: 0, ipv4: 1, ipv6: 2, bridge: 3 };

/**
 * The reachable addresses of a machine, ordered Tailscale, IPv4, IPv6, then bridges. `nets` is
 * what `os.networkInterfaces()` returns. `port` is the hub's port, and `scheme` is the one it
 * serves (the hub itself speaks plain http).
 */
export function listPairingInterfaces(
  nets: NodeJS.Dict<NetworkInterfaceInfo[]>,
  port: number,
  scheme: "http" | "https" = "http",
): PairingInterface[] {
  const out: PairingInterface[] = [];
  const seen = new Set<string>();
  for (const [name, infos] of Object.entries(nets)) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      const address = info.address;
      if (isLinkLocalV6(address) || isProxyFakeIp(address)) continue;
      // Windows-style `169.254.x.x` self-assigned addresses are not reachable either.
      if (address.startsWith("169.254.")) continue;
      const v6 = info.family === "IPv6" || address.includes(":");
      const kind: PairingAddressKind = BRIDGE_NAME.test(name)
        ? "bridge"
        : !v6 && isTailscale(address)
          ? "tailscale"
          : v6
            ? "ipv6"
            : "ipv4";
      const key = `${name}|${address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        address,
        name,
        kind,
        url: `${scheme}://${v6 ? `[${address}]` : address}:${port}`,
        label: `${address} (${name})`,
      });
    }
  }
  // Array.prototype.sort is stable, so the OS order holds inside a kind.
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

/** The URL of a custom address, or null when it isn't an http(s) URL. A path, query or fragment is dropped. */
export function normalizeCustomAddress(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.origin;
}
