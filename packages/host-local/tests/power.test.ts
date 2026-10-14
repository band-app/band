import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isOnBattery, parsePmset, readLinuxPower } from "../src/process/power";

describe("parsePmset", () => {
  it("reads the power source from `pmset -g batt`", () => {
    assert.equal(
      parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%"),
      true,
    );
    assert.equal(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%"), false);
    assert.equal(parsePmset("something else"), null);
  });
});

describe("readLinuxPower", () => {
  let dir: string;
  const supply = (name: string, files: Record<string, string>) => {
    mkdirSync(join(dir, name), { recursive: true });
    for (const [file, value] of Object.entries(files))
      writeFileSync(join(dir, name, file), `${value}\n`);
  };

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "band-power-")));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("is unknown when the directory is missing or holds no battery", async () => {
    assert.equal(await readLinuxPower(join(dir, "missing")), null);
    supply("AC", { type: "Mains", online: "1" });
    assert.equal(await readLinuxPower(dir), null);
  });

  it("is on battery when a battery discharges and no mains supply is online", async () => {
    supply("BAT0", { type: "Battery", status: "Discharging" });
    supply("AC", { type: "Mains", online: "0" });
    assert.equal(await readLinuxPower(dir), true);
  });

  it("is plugged in when mains is online or the battery charges", async () => {
    writeFileSync(join(dir, "AC", "online"), "1\n");
    assert.equal(await readLinuxPower(dir), false);
    writeFileSync(join(dir, "AC", "online"), "0\n");
    writeFileSync(join(dir, "BAT0", "status"), "Charging\n");
    assert.equal(await readLinuxPower(dir), false);
  });
});

describe("isOnBattery", () => {
  it("honours BAND_POWER_STATE", async () => {
    process.env.BAND_POWER_STATE = "battery";
    assert.equal(await isOnBattery(), true);
    process.env.BAND_POWER_STATE = "ac";
    assert.equal(await isOnBattery(), false);
    delete process.env.BAND_POWER_STATE;
  });
});
