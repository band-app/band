import { getOrCreateToken } from "./state";

export function getToken(): string {
  return getOrCreateToken();
}
