import type { BandNative } from "./native.js";

/** `band-symbol://<name>?pt=13&w=0&s=4`: an SF Symbol as a PNG, for CSS `mask-image`. */
export const SYMBOL_SCHEME = "band-symbol";

export const SYMBOL_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  // `mask-image` fetches in CORS mode.
  corsEnabled: true,
} as const;

const NAME = /^[a-z0-9]+(\.[a-z0-9]+)*$/;
const cache = new Map<string, Buffer | null>();

export interface SymbolReply {
  status: number;
  body?: Buffer;
}

/** Answers one request. The name is a dotted SF Symbol name; anything else is a 400. */
export function symbolReply(url: string, native: BandNative | null): SymbolReply {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 400 };
  }
  const name = parsed.hostname;
  if (!NAME.test(name)) return { status: 400 };
  if (!native) return { status: 404 };
  const num = (key: string, fallback: number, min: number, max: number) => {
    const v = Number(parsed.searchParams.get(key) ?? fallback);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  const pt = num("pt", 13, 6, 96);
  const weight = num("w", 0, -0.8, 0.8);
  const scale = num("s", 4, 1, 6);
  const key = `${name}|${pt}|${weight}|${scale}`;
  if (!cache.has(key)) cache.set(key, native.symbolPNG(name, pt, weight, scale));
  const body = cache.get(key);
  return body ? { status: 200, body } : { status: 404 };
}

export function symbolResponse(url: string, native: BandNative | null): Response {
  const reply = symbolReply(url, native);
  if (reply.status !== 200 || !reply.body) return new Response(null, { status: reply.status });
  return new Response(new Uint8Array(reply.body), {
    headers: {
      "content-type": "image/png",
      "cache-control": "max-age=31536000, immutable",
      // Only the bundled UI page (an `app://` origin) loads these.
      "access-control-allow-origin": "*",
    },
  });
}
