// Test data for the GitHub avatar stub (`github-stub.ts`).

/** A valid 1x1 PNG. Real image bytes so a browser can decode it in e2e
 *  specs; byte-for-byte comparable in backend tests. */
export const AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
