import { describe, expect, it } from "vitest";
import {
  buildPairingOptions,
  pairingLink,
  pickDefaultAddress,
} from "../src/dashboard/lib/pairing-options";

const interfaces = [
  { url: "http://100.64.0.2:3456", label: "100.64.0.2 (utun4)", kind: "tailscale" as const },
  { url: "http://172.17.0.1:3456", label: "172.17.0.1 (docker0)", kind: "bridge" as const },
];

describe("pairing options", () => {
  it("defaults to the public URL, then lists the page, interfaces and custom addresses", () => {
    const options = buildPairingOptions({
      publicUrl: "https://hub.example.com",
      pageOrigin: "http://localhost:3456",
      interfaces,
      custom: ["https://band.example.ts.net"],
    });
    expect(options.map((o) => o.source)).toEqual([
      "public",
      "page",
      "interface",
      "interface",
      "custom",
    ]);
    expect(pickDefaultAddress(options)?.url).toBe("https://hub.example.com");
  });

  it("defaults to the page origin with no public URL, never to a bridge", () => {
    const options = buildPairingOptions({
      publicUrl: null,
      pageOrigin: "http://hub.lan:3456",
      interfaces: [interfaces[1]],
      custom: [],
    });
    expect(pickDefaultAddress(options)?.url).toBe("http://hub.lan:3456");
  });

  it("keeps a remembered choice that is still offered and falls back when it is gone", () => {
    const options = buildPairingOptions({
      publicUrl: "https://hub.example.com",
      pageOrigin: "http://localhost:3456",
      interfaces,
      custom: [],
    });
    expect(pickDefaultAddress(options, "http://100.64.0.2:3456")?.url).toBe(
      "http://100.64.0.2:3456",
    );
    expect(pickDefaultAddress(options, "http://gone:1")?.url).toBe("https://hub.example.com");
  });

  it("drops duplicates and builds the link", () => {
    const options = buildPairingOptions({
      publicUrl: "http://localhost:3456",
      pageOrigin: "http://localhost:3456",
      interfaces: [],
      custom: [],
    });
    expect(options).toHaveLength(1);
    expect(pairingLink("https://a.example.com/", "bdp_x")).toBe(
      "https://a.example.com/?pair=bdp_x",
    );
  });
});
