/** `BAND_LOCAL_HOST=off` turns off workspaces on the hub's own machine. Read on every call. */
export function isLocalHostEnabled(): boolean {
  const value = process.env.BAND_LOCAL_HOST?.trim().toLowerCase();
  return !(value === "off" || value === "false" || value === "0");
}
