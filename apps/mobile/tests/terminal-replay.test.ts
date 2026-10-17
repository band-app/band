/**
 * Replays recorded terminal sessions (tests/fixtures/terminal, made by scripts/record-terminal.mjs
 * from real PTYs) through SwiftTerm, the emulator the app's native view uses, and through xterm.js,
 * the web's emulator, and compares the final screens: text, cursor, the alternate-screen flag and
 * each cell's colors and style. It feeds raw bytes into SwiftTerm's headless Terminal (the
 * `replay` Swift package) and xterm.js's headless Terminal. The protocol client's own replay
 * (reset, snapshot, acks) is covered in packages/client/tests/terminal-client.test.ts. It needs
 * the Swift toolchain and downloads SwiftTerm on the first run, so it runs on macOS only.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import xterm from "@xterm/headless";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "tests/fixtures/terminal");
const REPLAY = join(ROOT, "modules/band-terminal/replay");
const Terminal = xterm.Terminal as unknown as new (options: Record<string, unknown>) => XTerm;

interface XCell {
  getChars(): string;
  getWidth(): number;
  isFgDefault(): boolean;
  isFgPalette(): boolean;
  getFgColor(): number;
  isBgDefault(): boolean;
  isBgPalette(): boolean;
  getBgColor(): number;
  isBold(): number;
  isItalic(): number;
  isUnderline(): number;
  isInverse(): number;
  isDim(): number;
}
interface XLine {
  translateToString(trim: boolean): string;
  getCell(x: number): XCell | undefined;
}
interface XTerm {
  cols: number;
  rows: number;
  buffer: {
    active: {
      type: string;
      baseY: number;
      cursorX: number;
      cursorY: number;
      getLine(y: number): XLine | undefined;
    };
  };
  write(data: Uint8Array, cb: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

interface Screen {
  cols: number;
  rows: number;
  alt: boolean;
  cursor: [number, number];
  lines: string[];
  /** [row, col, fg, bg, flags] for cells that are not plain. */
  cells: [number, number, string, string, string][];
}

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

async function xtermScreen(file: string): Promise<Screen> {
  const [head, ...events] = readFileSync(file, "utf8").trim().split("\n");
  const header = JSON.parse(head) as { cols: number; rows: number };
  const term = new Terminal({
    cols: header.cols,
    rows: header.rows,
    scrollback: 1000,
    allowProposedApi: true,
  });
  for (const line of events) {
    const event = JSON.parse(line) as { o?: string; r?: [number, number] };
    if (event.o !== undefined) {
      await new Promise<void>((done) => term.write(Buffer.from(event.o as string, "base64"), done));
    } else if (event.r) {
      term.resize(event.r[0], event.r[1]);
    }
  }
  const buf = term.buffer.active;
  const lines: string[] = [];
  const cells: Screen["cells"] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.baseY + y);
    lines.push((line?.translateToString(true) ?? "").trimEnd());
    for (let x = 0; line && x < term.cols; x++) {
      const c = line.getCell(x);
      if (!c || c.getWidth() === 0) continue;
      const blank = c.getChars() === "";
      const fg = c.isFgDefault()
        ? "d"
        : c.isFgPalette()
          ? `p${c.getFgColor()}`
          : hex(c.getFgColor());
      const bg = c.isBgDefault()
        ? "d"
        : c.isBgPalette()
          ? `p${c.getBgColor()}`
          : hex(c.getBgColor());
      const flags = `${c.isBold() ? "b" : ""}${c.isItalic() ? "i" : ""}${c.isUnderline() ? "u" : ""}${c.isInverse() ? "r" : ""}${c.isDim() ? "d" : ""}`;
      if (
        (!blank && (fg !== "d" || bg !== "d" || flags)) ||
        (blank && (bg !== "d" || c.isInverse()))
      ) {
        cells.push([y, x, fg, bg, flags]);
      }
    }
  }
  const screen: Screen = {
    cols: term.cols,
    rows: term.rows,
    alt: buf.type === "alternate",
    cursor: [buf.cursorX, buf.cursorY],
    lines,
    cells,
  };
  term.dispose();
  return screen;
}

const hasSwift =
  process.platform === "darwin" &&
  spawnSync("swift", ["--version"], { stdio: "ignore" }).status === 0;

function swiftScreen(file: string): Screen {
  const out = execFileSync(join(REPLAY, ".build/release/dump"), [file], { encoding: "utf8" });
  return JSON.parse(out) as Screen;
}

/**
 * Differences that are accepted, by recording and field. Each is the emulators disagreeing on a
 * corner, not a rendering fault in the app. None is listed unless a run found it.
 */
const ACCEPTED: Record<string, string[]> = {};

describe(
  "native terminal replay",
  {
    skip: !hasSwift && "needs macOS and the Swift toolchain",
  },
  () => {
    before(() => {
      if (hasSwift)
        execFileSync("swift", ["build", "-c", "release"], { cwd: REPLAY, stdio: "inherit" });
    });
    const recordings = readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    for (const name of recordings) {
      it(`${name.replace(".jsonl", "")}: the final screen matches xterm.js`, async () => {
        const file = join(FIXTURES, name);
        const expected = await xtermScreen(file);
        const actual = swiftScreen(file);
        const accepted = new Set(ACCEPTED[name] ?? []);
        for (const field of ["cols", "rows", "alt", "cursor", "lines", "cells"] as const) {
          if (accepted.has(field)) continue;
          assert.deepEqual(actual[field], expected[field], `${name}: ${field}`);
        }
      });
    }
  },
);
