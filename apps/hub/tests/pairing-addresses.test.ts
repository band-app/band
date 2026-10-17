// `listPairingInterfaces` and `normalizeCustomAddress` are pure functions (an `os.networkInterfaces()`
// snapshot in, a list out), and the interfaces of the machine running the test can't be chosen, so
// they are tested with fixture lists. The procedure that calls them is covered through the real
// server in `device-pairing.test.ts`.

import type { NetworkInterfaceInfo } from "node:os";

import { describe, expect, it } from "vite-plus/test";

import {
  listPairingInterfaces,
  normalizeCustomAddress,
} from "../src/server/services/_utils/pairing-addresses";

function nic(
  address: string,
  opts: { family?: "IPv4" | "IPv6"; internal?: boolean } = {},
): NetworkInterfaceInfo {
  const family = opts.family ?? (address.includes(":") ? "IPv6" : "IPv4");
  return {
    address,
    family,
    internal: opts.internal ?? false,
    netmask: "",
    mac: "",
    cidr: null,
    scopeid: 0,
  } as NetworkInterfaceInfo;
}

describe("listPairingInterfaces", () => {
  it("orders Tailscale, IPv4, global IPv6, then bridges, and drops the rest", () => {
    const out = listPairingInterfaces(
      {
        lo0: [nic("127.0.0.1", { internal: true }), nic("::1", { internal: true })],
        docker0: [nic("172.17.0.1")],
        "br-1a2b": [nic("172.18.0.1")],
        en0: [nic("fe80::1c2:3d4", { family: "IPv6" }), nic("2001:db8::7"), nic("192.168.1.20")],
        utun4: [nic("100.101.102.103")],
        utun7: [nic("198.18.0.1"), nic("198.19.255.1")],
        veth9: [nic("10.0.0.5")],
      },
      3456,
    );
    expect(out.map((i) => `${i.kind}:${i.address}`)).toEqual([
      "tailscale:100.101.102.103",
      "ipv4:192.168.1.20",
      "ipv6:2001:db8::7",
      "bridge:172.17.0.1",
      "bridge:172.18.0.1",
      "bridge:10.0.0.5",
    ]);
  });

  it("labels each address with its interface and builds the URL with the port", () => {
    const [v4, v6] = listPairingInterfaces(
      { en0: [nic("192.168.1.20"), nic("2001:db8::7")] },
      4000,
    );
    expect(v4).toMatchObject({ label: "192.168.1.20 (en0)", url: "http://192.168.1.20:4000" });
    expect(v6).toMatchObject({ label: "2001:db8::7 (en0)", url: "http://[2001:db8::7]:4000" });
  });

  it("lists a container's eth0 as IPv4 and the docker bridge last", () => {
    const out = listPairingInterfaces(
      { eth0: [nic("172.17.0.2")], docker0: [nic("172.17.0.1")] },
      3456,
    );
    expect(out.map((i) => i.kind)).toEqual(["ipv4", "bridge"]);
    // eth0 is not named like a bridge, so it counts as IPv4. Only named bridges rank last.
  });

  it("detects Hyper-V, WSL and VMware names as bridges", () => {
    const out = listPairingInterfaces(
      {
        "vEthernet (WSL)": [nic("172.20.0.1")],
        "VMware Network Adapter VMnet8": [nic("192.168.40.1")],
        Ethernet: [nic("10.1.1.4")],
      },
      3456,
    );
    expect(out.map((i) => i.kind)).toEqual(["ipv4", "bridge", "bridge"]);
  });
});

describe("normalizeCustomAddress", () => {
  it("keeps the origin of an http(s) URL", () => {
    expect(normalizeCustomAddress(" https://band.example.ts.net/ ")).toBe(
      "https://band.example.ts.net",
    );
    expect(normalizeCustomAddress("http://10.0.0.4:3456/x?y=1")).toBe("http://10.0.0.4:3456");
  });

  it("refuses other schemes, credentials and text", () => {
    for (const bad of ["ftp://a.com", "band://pair", "https://u:p@a.com", "a.com", ""]) {
      expect(normalizeCustomAddress(bad)).toBeNull();
    }
  });
});
