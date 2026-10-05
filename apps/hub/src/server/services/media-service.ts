/**
 * The media blob store (plan step 5.1): screenshots, verification evidence and
 * videos that context files reference as `band://media/<id>`. A blob is stored
 * under `<BAND_HOME>/media/<id>` where the id is the lowercase hex SHA-256 of
 * its bytes, so the same content has one id and an id can't be forged for
 * other content. The content type sits beside it in `<id>.type`.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { bandHome } from "./state";

export const MEDIA_ID = /^[0-9a-f]{64}$/;
export const DEFAULT_MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** Types the store accepts. SVG and HTML are left out: served from the hub's origin they could run script. */
export const ALLOWED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
]);

export class MediaRefusedError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "MediaRefusedError";
  }
}

export function maxMediaBytes(): number {
  const n = Number(process.env.BAND_MEDIA_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MEDIA_BYTES;
}

function mediaDir(): string {
  return join(bandHome(), "media");
}

/** The bare media type of a Content-Type header, lowercased, or null when it isn't allowed. */
export function allowedMediaType(header: string | undefined): string | null {
  const type = (header ?? "").split(";")[0].trim().toLowerCase();
  return ALLOWED_MEDIA_TYPES.has(type) ? type : null;
}

export interface StoredMedia {
  id: string;
  size: number;
  contentType: string;
  created: boolean;
}

export const mediaService = {
  /**
   * Stores a stream. With `expectedId` the content must hash to it. Throws
   * {@link MediaRefusedError} for a bad type, a body over the limit or an id
   * that does not match the content.
   */
  async put(
    body: Readable,
    contentTypeHeader: string | undefined,
    expectedId?: string,
  ): Promise<StoredMedia> {
    const contentType = allowedMediaType(contentTypeHeader);
    if (!contentType) {
      body.resume();
      throw new MediaRefusedError(415, "That content type is not allowed");
    }
    const dir = mediaDir();
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.upload-${randomBytes(8).toString("hex")}`);
    const hash = createHash("sha256");
    const limit = maxMediaBytes();
    let size = 0;
    const out = createWriteStream(tmp);
    try {
      for await (const chunk of body) {
        size += (chunk as Buffer).byteLength;
        if (size > limit) throw new MediaRefusedError(413, `Larger than ${limit} bytes`);
        hash.update(chunk as Buffer);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", r));
      }
      await new Promise<void>((resolve, reject) => {
        out.once("error", reject);
        out.end(resolve);
      });
      if (size === 0) throw new MediaRefusedError(400, "Empty body");
      const id = hash.digest("hex");
      if (expectedId && expectedId !== id) {
        throw new MediaRefusedError(400, "The id is not the SHA-256 of the content");
      }
      const target = join(dir, id);
      const created = !existsSync(target);
      // The type file goes first: a blob is only visible once its type is, and a
      // blob left without one by a crash gets it on the next upload.
      const typePath = join(dir, `${id}.type`);
      if (created || !existsSync(typePath)) {
        const typeTmp = join(dir, `.type-${randomBytes(8).toString("hex")}`);
        writeFileSync(typeTmp, contentType);
        renameSync(typeTmp, typePath);
      }
      if (created) renameSync(tmp, target);
      else rmSync(tmp, { force: true });
      return {
        id,
        size,
        contentType: created ? contentType : (this.meta(id)?.contentType ?? contentType),
        created,
      };
    } catch (err) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw err;
    }
  },

  meta(id: string): { size: number; contentType: string } | null {
    if (!MEDIA_ID.test(id)) return null;
    try {
      const size = statSync(join(mediaDir(), id)).size;
      const contentType = readFileSync(join(mediaDir(), `${id}.type`), "utf8").trim();
      return { size, contentType };
    } catch {
      return null;
    }
  },

  read(id: string, range?: { start: number; end: number }): Readable {
    return createReadStream(join(mediaDir(), id), range);
  },
};
