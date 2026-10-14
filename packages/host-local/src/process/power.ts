import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** How long a power reading stays valid. `describeHost` is called often; the machine is asked at most this often. */
const POWER_TTL_MS = 60_000;
const PMSET_TIMEOUT_MS = 3_000;
const POWER_SUPPLY_DIR = "/sys/class/power_supply";

/** Parses `pmset -g batt`: "Now drawing from 'Battery Power'" or "'AC Power'". */
export function parsePmset(output: string): boolean | null {
  if (/drawing from 'Battery Power'/i.test(output)) return true;
  if (/drawing from '(AC Power|UPS Power)'/i.test(output)) return false;
  return null;
}

async function readTrim(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * Reads `/sys/class/power_supply`. On battery means a battery is discharging
 * and no mains supply is online. No battery at all (a server) is unknown.
 */
export async function readLinuxPower(dir = POWER_SUPPLY_DIR): Promise<boolean | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let hasBattery = false;
  let discharging = false;
  let mainsOnline = false;
  for (const name of entries) {
    const type = await readTrim(join(dir, name, "type"));
    if (type === "Battery") {
      hasBattery = true;
      if ((await readTrim(join(dir, name, "status"))) === "Discharging") discharging = true;
    } else if (type === "Mains" || type === "USB") {
      if ((await readTrim(join(dir, name, "online"))) === "1") mainsOnline = true;
    }
  }
  if (!hasBattery) return null;
  return discharging && !mainsOnline;
}

function readMacPower(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("pmset", ["-g", "batt"], { timeout: PMSET_TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? null : parsePmset(stdout)),
    );
  });
}

let cached: { at: number; value: boolean | null } | null = null;
let inFlight: Promise<boolean | null> | null = null;

/**
 * Whether this machine runs on battery. `null` is unknown (no battery, Windows,
 * a failed probe) and counts as plugged in. The answer is cached for a minute,
 * so a caller that asks on every `host.info` never starts a process more often than that.
 */
export function isOnBattery(now = Date.now()): Promise<boolean | null> {
  // An operator (or a test) can pin the answer: `BAND_POWER_STATE=battery|ac`. Read on every call.
  const forced = process.env.BAND_POWER_STATE;
  if (forced === "battery") return Promise.resolve(true);
  if (forced === "ac") return Promise.resolve(false);
  if (cached && now - cached.at < POWER_TTL_MS) return Promise.resolve(cached.value);
  if (inFlight) return inFlight;
  const read =
    process.platform === "darwin"
      ? readMacPower()
      : process.platform === "linux"
        ? readLinuxPower()
        : Promise.resolve(null);
  inFlight = read
    .catch(() => null)
    .then((value) => {
      cached = { at: now, value };
      inFlight = null;
      return value;
    });
  return inFlight;
}
