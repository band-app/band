import type {
  AccountUsage,
  AccountUsageFailure,
  AccountUsageProvider,
  UsageWindow,
} from "@band-app/host-api";

import { hostRegistry } from "../infra/host/registry";
import { tokenService } from "./token-service";

const LOCAL_HOST_ID = "local";
/** A host that does not answer must not hold up the popover. */
const HOST_TIMEOUT_MS = 20_000;

/** One account in the popover: a login seen on one or more hosts. */
export interface AccountUsageRow {
  provider: AccountUsageProvider;
  /** Email or account id. Null when the login names neither. */
  account: string | null;
  plan: string | null;
  windows: UsageWindow[];
  /** Names of the hosts that hold this login. */
  hosts: string[];
  updatedAt: number;
}

/** Hosts where a provider has no numbers for one reason. */
export interface AccountUsageProblem {
  provider: AccountUsageProvider;
  reason: AccountUsageFailure | "offline";
  /** A short sentence for the popover, such as "Not logged in on contabo". */
  message: string;
  hosts: string[];
}

export interface AccountUsageReport {
  rows: AccountUsageRow[];
  problems: AccountUsageProblem[];
}

const MESSAGES: Record<AccountUsageFailure, string> = {
  "not-logged-in": "Not logged in on",
  expired: "Login expired on",
  "rate-limited": "Usage is rate limited on",
  error: "Couldn't refresh usage on",
};

interface HostReading {
  hostName: string;
  usage: AccountUsage[] | null;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), HOST_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function readHost(hostId: string, hostName: string, refresh: boolean): Promise<HostReading> {
  try {
    const usage = await withTimeout(
      hostRegistry.hostById(hostId).agentEnv.accountUsage({ refresh }),
    );
    return { hostName, usage };
  } catch {
    return { hostName, usage: null };
  }
}

function sentence(prefix: string, hosts: string[]): string {
  return `${prefix} ${hosts.join(", ")}`;
}

/**
 * Merges what each host reports. The same account on two hosts is one row that
 * names both. A login that names no account cannot be told apart from another,
 * so it stays one row per host.
 */
export function mergeAccountUsage(readings: HostReading[]): AccountUsageReport {
  const rows = new Map<string, AccountUsageRow>();
  const problems = new Map<string, AccountUsageProblem>();
  const addProblem = (
    provider: AccountUsageProvider,
    reason: AccountUsageProblem["reason"],
    host: string,
  ) => {
    const key = `${provider}:${reason}`;
    const found = problems.get(key);
    if (found) {
      found.hosts.push(host);
      found.message =
        reason === "offline"
          ? sentence("Offline:", found.hosts)
          : sentence(MESSAGES[reason], found.hosts);
      return;
    }
    problems.set(key, {
      provider,
      reason,
      message:
        reason === "offline" ? sentence("Offline:", [host]) : sentence(MESSAGES[reason], [host]),
      hosts: [host],
    });
  };

  for (const reading of readings) {
    if (reading.usage === null) {
      // The host did not answer: every provider is unknown there.
      for (const provider of ["claude", "codex"] as const)
        addProblem(provider, "error", reading.hostName);
      continue;
    }
    for (const usage of reading.usage) {
      if (usage.status !== "ok") {
        addProblem(usage.provider, usage.status, reading.hostName);
        continue;
      }
      const key = `${usage.provider}:${usage.account ? usage.account.toLowerCase() : `host:${reading.hostName}`}`;
      const found = rows.get(key);
      if (!found) {
        rows.set(key, {
          provider: usage.provider,
          account: usage.account,
          plan: usage.plan,
          windows: usage.windows,
          hosts: [reading.hostName],
          updatedAt: usage.updatedAt,
        });
        continue;
      }
      found.hosts.push(reading.hostName);
      // Both hosts read the same account, so the newer reading is the better one.
      if (usage.updatedAt > found.updatedAt) {
        found.windows = usage.windows;
        found.updatedAt = usage.updatedAt;
        found.plan = usage.plan ?? found.plan;
      } else {
        found.plan = found.plan ?? usage.plan;
      }
    }
  }
  return { rows: [...rows.values()], problems: [...problems.values()] };
}

/**
 * Usage of every Claude and Codex account found on an online host. Each host
 * reads its own logins and returns percentages, reset times, a plan and a
 * display identity. A token never leaves the host.
 */
export async function listAccountUsage(options?: {
  refresh?: boolean;
}): Promise<AccountUsageReport> {
  const refresh = options?.refresh === true;
  const hosts = tokenService
    .listHosts()
    .filter((h) => (h.id === LOCAL_HOST_ID ? h.usable : h.status === "online"));
  const readings = await Promise.all(hosts.map((h) => readHost(h.id, h.name, refresh)));
  return mergeAccountUsage(readings);
}
