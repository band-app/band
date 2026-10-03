// The only thing the UI takes from the hub: the router's type, for the tRPC
// client. Keep this file free of runtime exports so `apps/web` never bundles
// hub code.
export type { AppRouter } from "./server/api/router.ts";
