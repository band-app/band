import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { createLogger } from "@band-app/logger";
import { type ExtensionManifest, extensionManifestSchema } from "@band-app/plugin-api";
import { mimeTypeFromFilename } from "@band-app/worktree-ops/http-files";
import { bandHome } from "../infra/db/queries/settings";
import { readTarGz, TarError } from "./_utils/tar-extract";

const log = createLogger("extensions");

export const MANIFEST_FILE = "band-extension.json";

export interface InstalledExtension {
  manifest: ExtensionManifest;
}

export interface ExtensionProblem {
  /** The folder name under `<BAND_HOME>/extensions`. */
  folder: string;
  error: string;
}

export interface ExtensionList {
  extensions: ExtensionManifest[];
  errors: ExtensionProblem[];
}

/** One tool of an editor, as its `tools.json` lists it. */
export interface EditorToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ExtensionFile {
  stream: ReadStream;
  size: number;
  contentType: string;
  /** Set when the `.br` or `.gz` copy is served. */
  encoding?: "br" | "gzip";
}

/** The largest archive Band downloads or accepts, and the most it may expand to. */
export const MAX_INSTALL_BYTES = 200 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** A refusal with a message for the person installing. */
export class ExtensionInstallError extends Error {}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Extensions installed in `<BAND_HOME>/extensions/<id>/`. The folder is hub state, like uploads,
 * so this service reads it with `node:fs` (see its entry on the machine-access exempt list in
 * `biome.json`). It serves the files and nothing else: an extension runs no code on the hub.
 */
export class ExtensionService {
  private loaded: ExtensionList | null = null;
  private loading: Promise<ExtensionList> | null = null;
  /** Counts scans started. Only the newest scan may replace `loaded`. */
  private scanSeq = 0;

  private root(): string {
    return join(bandHome(), "extensions");
  }

  /** Reads every manifest again. A manifest that fails validation is skipped and listed as an error. */
  async reload(): Promise<ExtensionList> {
    const seq = ++this.scanSeq;
    const pending = this.scan();
    this.loading = pending;
    try {
      const result = await pending;
      if (seq === this.scanSeq) {
        this.loaded = result;
        return result;
      }
      // A newer scan began meanwhile, so this result may predate the change that caused it.
      return (await this.loading) ?? this.loaded ?? result;
    } finally {
      if (this.loading === pending) this.loading = null;
    }
  }

  async list(): Promise<ExtensionList> {
    if (this.loaded) return this.loaded;
    return this.loading ?? this.reload();
  }

  async get(id: string): Promise<ExtensionManifest | undefined> {
    return (await this.list()).extensions.find((e) => e.id === id);
  }

  /**
   * The tools an editor declares in its `tools` file (an MCP `tools/list` answer), minus the ones
   * marked `"agent": false`. A missing or malformed file gives none.
   */
  async agentTools(extensionId: string, editorId: string): Promise<EditorToolDef[]> {
    const manifest = await this.get(extensionId);
    const editor = manifest?.contributes.fileEditors.find((e) => e.id === editorId);
    if (!manifest || !editor?.tools) return [];
    try {
      const raw = await readFile(join(this.root(), manifest.id, editor.tools), "utf8");
      const parsed = JSON.parse(raw) as { tools?: unknown };
      if (!Array.isArray(parsed.tools)) return [];
      const out: EditorToolDef[] = [];
      for (const t of parsed.tools) {
        if (!t || typeof t !== "object") continue;
        const tool = t as Record<string, unknown>;
        if (typeof tool.name !== "string" || tool.agent === false) continue;
        out.push({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === "object"
              ? (tool.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
          ...(tool.annotations && typeof tool.annotations === "object"
            ? { annotations: tool.annotations as Record<string, unknown> }
            : {}),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  private async scan(): Promise<ExtensionList> {
    const extensions: ExtensionManifest[] = [];
    const errors: ExtensionProblem[] = [];
    let folders: string[];
    try {
      folders = (await readdir(this.root(), { withFileTypes: true }))
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort();
    } catch {
      return { extensions, errors };
    }
    for (const folder of folders) {
      const problem = (error: string) => {
        log.warn(`Skipping extension "${folder}": ${error}`);
        errors.push({ folder, error });
      };
      let raw: string;
      try {
        raw = await readFile(join(this.root(), folder, MANIFEST_FILE), "utf8");
      } catch {
        problem(`${MANIFEST_FILE} not found`);
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        problem(`${MANIFEST_FILE} is not valid JSON`);
        continue;
      }
      const parsed = extensionManifestSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        problem(`${issue.path.join(".") || "manifest"}: ${issue.message}`);
        continue;
      }
      const manifest = parsed.data;
      if (manifest.id !== folder) {
        problem(`id "${manifest.id}" does not match the folder name`);
        continue;
      }
      if (extensions.some((e) => e.id === manifest.id)) {
        problem(`duplicate id "${manifest.id}"`);
        continue;
      }
      extensions.push(manifest);
    }
    return { extensions, errors };
  }

  /** Downloads a release archive, checks its sha256 and installs it. */
  async install(url: string, sha256?: string): Promise<ExtensionManifest> {
    const parsed = parseInstallUrl(url);
    const archive = await download(parsed);
    let expected = sha256?.trim().toLowerCase();
    if (!expected) {
      const sibling = new URL(parsed);
      sibling.pathname += ".sha256";
      expected = await downloadChecksum(sibling);
    }
    return this.installArchive(archive, expected);
  }

  /**
   * Unpacks a `.tar.gz` with one top-level folder named by the extension's id and puts it in
   * `<BAND_HOME>/extensions/<id>`. The old version stays until the new one has passed every check.
   */
  async installArchive(archive: Buffer, sha256?: string): Promise<ExtensionManifest> {
    if (archive.length > MAX_INSTALL_BYTES) {
      throw new ExtensionInstallError("The archive is over the 200 MB limit");
    }
    if (sha256) {
      if (!/^[0-9a-f]{64}$/i.test(sha256)) {
        throw new ExtensionInstallError("The sha256 is not 64 hex characters");
      }
      const actual = createHash("sha256").update(archive).digest("hex");
      if (actual !== sha256.toLowerCase()) {
        throw new ExtensionInstallError("The archive does not match its sha256");
      }
    }
    let files: ReturnType<typeof readTarGz>;
    try {
      files = readTarGz(archive, { maxBytes: MAX_EXPANDED_BYTES, maxEntries: 20_000 });
    } catch (err) {
      if (err instanceof TarError) throw new ExtensionInstallError(err.message);
      throw err;
    }
    if (files.length === 0) throw new ExtensionInstallError("The archive has no files");
    const tops = new Set(files.map((f) => f.path.split("/")[0]));
    if (tops.size !== 1 || files.some((f) => !f.path.includes("/"))) {
      throw new ExtensionInstallError(
        "The archive must hold one top-level folder and nothing else",
      );
    }
    const folder = [...tops][0] as string;
    if (!ID_PATTERN.test(folder)) {
      throw new ExtensionInstallError(`"${folder}" is not a valid extension id`);
    }
    const manifestFile = files.find((f) => f.path === `${folder}/${MANIFEST_FILE}`);
    if (!manifestFile) throw new ExtensionInstallError(`The archive has no ${MANIFEST_FILE}`);
    let json: unknown;
    try {
      json = JSON.parse(manifestFile.data.toString("utf8"));
    } catch {
      throw new ExtensionInstallError(`${MANIFEST_FILE} is not valid JSON`);
    }
    const parsed = extensionManifestSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ExtensionInstallError(
        `${MANIFEST_FILE}: ${issue.path.join(".") || "manifest"}: ${issue.message}`,
      );
    }
    if (parsed.data.id !== folder) {
      throw new ExtensionInstallError(
        `The folder "${folder}" does not match the manifest id "${parsed.data.id}"`,
      );
    }

    const root = this.root();
    const tag = randomBytes(6).toString("hex");
    const staging = join(root, `.install-${tag}`);
    const target = join(root, folder);
    const backup = join(root, `.old-${tag}`);
    try {
      for (const file of files) {
        const dest = join(staging, file.path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, file.data, { mode: 0o644 });
      }
      let hadOld = false;
      try {
        await rename(target, backup);
        hadOld = true;
      } catch {
        // nothing installed under this id yet
      }
      try {
        await rename(join(staging, folder), target);
      } catch (err) {
        if (hadOld) await rename(backup, target).catch(() => {});
        throw err;
      }
      if (hadOld) await rm(backup, { recursive: true, force: true });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    log.info(`Installed extension "${folder}" ${parsed.data.version}`);
    await this.reload();
    return parsed.data;
  }

  /** Deletes an installed extension's folder. */
  async remove(id: string): Promise<void> {
    if (!ID_PATTERN.test(id))
      throw new ExtensionInstallError(`"${id}" is not a valid extension id`);
    const dir = join(this.root(), id);
    try {
      await stat(dir);
    } catch {
      throw new ExtensionInstallError(`No extension "${id}" is installed`);
    }
    await rm(dir, { recursive: true, force: true });
    await this.reload();
  }

  /**
   * Opens one file of an extension for `GET /ext/<id>/<path>`. Resolves undefined for an unknown
   * id, a path that leaves the folder (`..` or a symlink out) and a folder or missing file.
   */
  async open(id: string, relPath: string, acceptEncoding = ""): Promise<ExtensionFile | undefined> {
    if (!ID_PATTERN.test(id) || !(await this.get(id))) return undefined;
    if (relPath.includes("\0") || relPath.includes("\\")) return undefined;
    const segments = relPath.split("/");
    if (segments.some((s) => s === ".." || s === "." || s === "")) return undefined;
    let dir: string;
    try {
      dir = await realpath(join(this.root(), id));
    } catch {
      return undefined;
    }
    const contentType = mimeTypeFromFilename(segments[segments.length - 1] ?? "");
    const wanted: Array<{ suffix: string; encoding?: "br" | "gzip" }> = [];
    if (/\bbr\b/.test(acceptEncoding)) wanted.push({ suffix: ".br", encoding: "br" });
    if (/\bgzip\b/.test(acceptEncoding)) wanted.push({ suffix: ".gz", encoding: "gzip" });
    wanted.push({ suffix: "" });
    for (const { suffix, encoding } of wanted) {
      const candidate = join(dir, ...segments) + suffix;
      try {
        const real = await realpath(candidate);
        if (!real.startsWith(dir + sep)) return undefined;
        const info = await stat(real);
        if (!info.isFile()) continue;
        return { stream: createReadStream(real), size: info.size, contentType, encoding };
      } catch {
        // try the next candidate
      }
    }
    return undefined;
  }
}

function parseInstallUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ExtensionInstallError("The URL is not valid");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new ExtensionInstallError("The URL must be https, or http on loopback");
  }
  if (parsed.username || parsed.password) {
    throw new ExtensionInstallError("The URL must not hold credentials");
  }
  return parsed;
}

async function fetchLimited(url: URL, maxBytes: number): Promise<Buffer | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch {
    throw new ExtensionInstallError(`Could not download ${url.host}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ExtensionInstallError(`The download failed (${res.status})`);
  const finalUrl = new URL(res.url || url.toString());
  if (finalUrl.protocol !== "https:" && finalUrl.protocol !== url.protocol) {
    throw new ExtensionInstallError("The download was redirected to an insecure URL");
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ExtensionInstallError("The archive is over the 200 MB limit");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new ExtensionInstallError("The archive is over the 200 MB limit");
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    if (err instanceof ExtensionInstallError) throw err;
    throw new ExtensionInstallError("The download was interrupted");
  }
  return Buffer.concat(chunks);
}

async function download(url: URL): Promise<Buffer> {
  const bytes = await fetchLimited(url, MAX_INSTALL_BYTES);
  if (!bytes) throw new ExtensionInstallError("The URL was not found (404)");
  return bytes;
}

/** The checksum in `<url>.sha256`, or undefined when the release has none. */
async function downloadChecksum(url: URL): Promise<string | undefined> {
  const bytes = await fetchLimited(url, 4096).catch(() => null);
  const token = bytes?.toString("utf8").trim().split(/\s+/)[0];
  return token && /^[0-9a-f]{64}$/i.test(token) ? token : undefined;
}

export const extensionService = new ExtensionService();
