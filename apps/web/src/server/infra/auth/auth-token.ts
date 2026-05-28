import { getOrCreateToken } from "../../services/state";

export function getToken(): string {
  return getOrCreateToken();
}
