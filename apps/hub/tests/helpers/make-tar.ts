import { gzipSync } from "node:zlib";

export interface TarEntry {
  name: string;
  data?: Buffer | string;
  /** `0` file, `5` folder, `2` symlink, `1` hard link. */
  type?: "0" | "5" | "2" | "1";
  linkname?: string;
}

function field(value: string, length: number): Buffer {
  const buf = Buffer.alloc(length);
  buf.write(value, 0, "utf8");
  return buf;
}

/** Builds a `.tar.gz` in memory, so a test can include entries a real `tar` would not write. */
export function makeTarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    field(entry.name, 100).copy(header, 0);
    field("0000644\0", 8).copy(header, 100);
    field("0000000\0", 8).copy(header, 108);
    field("0000000\0", 8).copy(header, 116);
    field(`${data.length.toString(8).padStart(11, "0")}\0`, 12).copy(header, 124);
    field("00000000000\0", 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156);
    if (entry.linkname) field(entry.linkname, 100).copy(header, 157);
    field("ustar\0", 6).copy(header, 257);
    field("00", 2).copy(header, 263);
    const sum = header.reduce((a, b) => a + b, 0);
    field(`${sum.toString(8).padStart(6, "0")}\0 `, 8).copy(header, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
