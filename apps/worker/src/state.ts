import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SESSION_TOKEN_FILE = "session-token";
const WORKER_ID_FILE = "worker-id";

/** The worker's private directory. Mode 0700, created on first use. */
export async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
}

async function readTrimmed(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text === "" ? undefined : text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Writes through a temp file and a rename, so a crash never leaves a half-written secret. */
async function writePrivate(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${text}\n`, { mode: 0o600 });
  // writeFile's mode only applies to a new file and the umask can narrow it, so set it outright.
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** The id this machine's worker presents to the hub. Created once, then stable across restarts. */
export async function loadOrCreateWorkerId(stateDir: string): Promise<string> {
  const path = join(stateDir, WORKER_ID_FILE);
  const existing = await readTrimmed(path);
  if (existing) return existing;
  const id = `w-${randomBytes(6).toString("hex")}`;
  await writePrivate(path, id);
  return id;
}

/** Replaces the saved worker id, for a worker the hub named when it traded its bootstrap token. */
export async function writeWorkerId(stateDir: string, id: string): Promise<void> {
  await writePrivate(join(stateDir, WORKER_ID_FILE), id);
}

export function readSessionToken(stateDir: string): Promise<string | undefined> {
  return readTrimmed(join(stateDir, SESSION_TOKEN_FILE));
}

/** Saves the session token unless the file already holds it. */
export async function writeSessionToken(stateDir: string, token: string): Promise<void> {
  const path = join(stateDir, SESSION_TOKEN_FILE);
  if ((await readSessionToken(stateDir)) === token) {
    await chmod(path, 0o600);
    return;
  }
  await writePrivate(path, token);
}
