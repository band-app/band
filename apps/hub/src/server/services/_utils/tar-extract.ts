import { gunzipSync } from "node:zlib";

export class TarError extends Error {}

export interface TarFile {
  /** Path inside the archive, without a leading `./`. */
  path: string;
  data: Buffer;
}

export interface TarLimits {
  /** The most bytes the archive may expand to. */
  maxBytes: number;
  maxEntries: number;
}

const BLOCK = 512;

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(buf: Buffer, start: number, length: number): number {
  const text = cString(buf, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError("The archive has a bad header");
  return Number.parseInt(text, 8);
}

function paxPath(data: Buffer): string | undefined {
  let rest = data.toString("utf8");
  while (rest.length > 0) {
    const space = rest.indexOf(" ");
    const length = Number.parseInt(rest.slice(0, space), 10);
    if (!Number.isFinite(length) || length <= space) return undefined;
    const record = rest.slice(space + 1, length - 1);
    if (record.startsWith("path=")) return record.slice(5);
    rest = rest.slice(length);
  }
  return undefined;
}

function safePath(raw: string): string {
  const path = raw.replace(/^(\.\/)+/, "");
  if (path === "" || path === ".") return "";
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new TarError(`The archive has an unsafe path: ${raw}`);
  }
  if (path.split("/").some((s) => s === "..")) {
    throw new TarError(`The archive has an unsafe path: ${raw}`);
  }
  return path.replace(/\/+$/, "");
}

/**
 * Reads the regular files of a `.tar.gz` held in memory. Refuses anything that is not a plain
0, hard links, devices), any absolute path or `..` segment, and an
 * archive that expands past `limits`. Nothing is written: the caller decides where files go.
 */
export function readTarGz(archive: Buffer, limits: TarLimits): TarFile[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: limits.maxBytes });
  } catch (err) {
    const tooBig = (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
    throw new TarError(
      tooBig ? "The archive expands to more than the size limit" : "The file is not a .tar.gz",
    );
  }
  const files: TarFile[] = [];
  let pending: string | undefined;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = cString(header, 345, 155);
    let name = cString(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new TarError("The archive is cut short");
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      pending = paxPath(data) ?? pending;
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      pending = cString(data, 0, data.length);
      continue;
    }
    const path = safePath(pending ?? name);
    pending = undefined;
    if (type === "5") continue;
    if (type !== "0" && type !== "7") {
      const kind = type === "1" ? "hard link" : type === "2" ? "symlink" : "special file";
      throw new TarError(`The archive has a ${kind}: ${path}. Links are not allowed.`);
    }
    if (path === "") throw new TarError("The archive has an empty file name");
    // macOS `tar` adds `._name` metadata files; they hold no extension content.
    if ((path.split("/").pop() ?? "").startsWith("._")) continue;
    if (files.length >= limits.maxEntries) throw new TarError("The archive has too many files");
    files.push({ path, data: Buffer.from(data) });
  }
  return files;
}
