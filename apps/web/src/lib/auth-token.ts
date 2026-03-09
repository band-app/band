import { createHmac } from "node:crypto";

export function getToken(): string | null {
  const secret = process.env.BAND_TOKEN_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update("band-access").digest("hex");
}
