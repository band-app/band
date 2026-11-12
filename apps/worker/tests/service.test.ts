import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  LAUNCHD_LABEL,
  renderEnvFile,
  renderLaunchdPlist,
  renderSystemdUnit,
  SYSTEMD_UNIT,
} from "../src/service.ts";
import { cleanup, tmpDir, WORKER_BIN } from "./helpers.ts";

const TOKEN = "bwb_secret-token-value";

/** Directory of stub service managers that record their arguments, put first on PATH. */
function stubBin(home: string): { bin: string; calls: () => string[] } {
  const bin = join(home, "stub-bin");
  mkdirSync(bin);
  const log = join(home, "calls.log");
  for (const name of ["systemctl", "loginctl", "launchctl"]) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\n`);
    chmodSync(file, 0o755);
  }
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

function run(home: string, bin: string, args: string[]) {
  return spawnSync(process.execPath, [WORKER_BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, BAND_WORKER_TOKEN: "" },
  });
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("render", () => {
  it("writes a systemd unit that reads the env file", () => {
    const unit = renderSystemdUnit({
      node: "/usr/bin/node",
      script: "/opt/band worker/bin/band-worker.mjs",
      envFile: "/home/u/.band/worker-service/worker.env",
    });
    assert.match(unit, /^EnvironmentFile=\/home\/u\/\.band\/worker-service\/worker\.env$/m);
    assert.match(
      unit,
      /^ExecStart="\/usr\/bin\/node" "\/opt\/band worker\/bin\/band-worker\.mjs"$/m,
    );
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^KillMode=process$/m, "a restart must leave the terminals' shells running");
    const service = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
    assert.match(
      service,
      /^OOMPolicy=continue$/m,
      "an agent killed for running out of memory must not stop the worker",
    );
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.ok(!unit.includes(TOKEN));
  });

  it("quotes env file values", () => {
    assert.equal(
      renderEnvFile({ BAND_WORKER_NAME: 'a "b" \\c' }),
      'BAND_WORKER_NAME="a \\"b\\" \\\\c"\n',
    );
  });

  it("writes a launchd plist with the environment and escapes XML", () => {
    const plist = renderLaunchdPlist({
      node: "/usr/local/bin/node",
      script: "/x/band-worker.mjs",
      vars: { BAND_HUB_URL: "https://hub.example.com", BAND_WORKER_NAME: "a&b" },
      logFile: "/x/worker.log",
    });
    assert.ok(plist.includes(`<string>${LAUNCHD_LABEL}</string>`));
    assert.ok(
      plist.includes("<key>BAND_HUB_URL</key>\n    <string>https://hub.example.com</string>"),
    );
    assert.ok(plist.includes("<string>a&amp;b</string>"));
    assert.ok(plist.includes("<key>KeepAlive</key>\n  <true/>"));
    // launchd cannot rotate its output file, so the worker writes and rotates /x/worker.log itself.
    assert.ok(plist.includes("<key>BAND_LOG_FILE</key>\n    <string>/x/worker.log</string>"));
    assert.ok(plist.includes("<key>StandardOutPath</key>\n  <string>/dev/null</string>"));
    assert.ok(plist.includes("<key>StandardErrorPath</key>\n  <string>/dev/null</string>"));
  });
});

describe("install-service", () => {
  const dirs: string[] = [];
  after(() => cleanup(...dirs));

  const supported = platform() === "linux" || platform() === "darwin";

  it("keeps --own-chats in the service's environment", { skip: !supported }, () => {
    const home = tmpDir("band-service-own-");
    dirs.push(home);
    const { bin } = stubBin(home);
    const install = run(home, bin, [
      "install-service",
      "--hub",
      "https://hub.example.com",
      "--token",
      TOKEN,
      "--own-chats",
    ]);
    assert.equal(install.status, 0, install.stderr);
    const secretFile =
      platform() === "linux"
        ? join(home, ".band", "worker-service", "worker.env")
        : join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    assert.match(
      readFileSync(secretFile, "utf8"),
      platform() === "linux"
        ? /BAND_WORKER_OWN_CHATS="1"/
        : /<key>BAND_WORKER_OWN_CHATS<\/key>\s*<string>1<\/string>/,
    );
  });

  it("points the worker's log at worker.log on both platforms", { skip: !supported }, () => {
    const home = tmpDir("band-service-log-");
    dirs.push(home);
    const { bin } = stubBin(home);
    const install = run(home, bin, [
      "install-service",
      "--hub",
      "https://hub.example.com",
      "--token",
      TOKEN,
    ]);
    assert.equal(install.status, 0, install.stderr);
    const file =
      platform() === "linux"
        ? join(home, ".band", "worker-service", "worker.env")
        : join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const logPath = join(home, ".band", "worker-service", "worker.log");
    assert.ok(readFileSync(file, "utf8").includes(logPath));
  });

  describe("launchctl bootstrap failing", { skip: platform() !== "darwin" }, () => {
    const failingLaunchctl = (bin: string, code: number, message: string) => {
      writeFileSync(
        join(bin, "launchctl"),
        `#!/bin/sh\n[ "$1" = bootstrap ] && { echo "${message}" >&2; exit ${code}; }\nexit 0\n`,
      );
      chmodSync(join(bin, "launchctl"), 0o755);
    };
    const args = ["install-service", "--hub", "https://hub.example.com", "--token", TOKEN];

    it("exits 0 and says the worker starts at next login when there is no GUI session", () => {
      const home = tmpDir("band-service-nosession-");
      dirs.push(home);
      const { bin } = stubBin(home);
      failingLaunchctl(bin, 125, "Bootstrap failed: 125: Domain does not support specified action");
      const install = run(home, bin, args);
      assert.equal(install.status, 0, install.stderr);
      assert.match(install.stdout, /starts at the next login/);
      assert.ok(existsSync(join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)));
    });

    it("still fails for another launchctl error", () => {
      const home = tmpDir("band-service-badplist-");
      dirs.push(home);
      const { bin } = stubBin(home);
      failingLaunchctl(bin, 5, "Bootstrap failed: 5: Input/output error");
      const install = run(home, bin, args);
      assert.notEqual(install.status, 0);
    });
  });

  it("installs, reports status and uninstalls", { skip: !supported }, () => {
    const home = tmpDir("band-service-");
    dirs.push(home);
    const { bin, calls } = stubBin(home);

    const install = run(home, bin, [
      "install-service",
      "--hub",
      "https://hub.example.com",
      "--token",
      TOKEN,
      "--name",
      "build-box",
      "--labels",
      "os=linux",
      "--root",
      "/srv/work",
    ]);
    assert.equal(install.status, 0, install.stderr);
    assert.ok(!install.stdout.includes(TOKEN));
    assert.ok(!install.stderr.includes(TOKEN));

    const serviceDir = join(home, ".band", "worker-service");
    assert.equal(mode(serviceDir), 0o700);
    const secretFile =
      platform() === "linux"
        ? join(serviceDir, "worker.env")
        : join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    assert.equal(mode(secretFile), 0o600);
    const content = readFileSync(secretFile, "utf8");
    assert.ok(content.includes(TOKEN));
    assert.ok(content.includes("https://hub.example.com"));
    assert.ok(content.includes("build-box"));
    assert.ok(content.includes("os=linux"));
    assert.ok(content.includes("/srv/work"));

    if (platform() === "linux") {
      const unit = readFileSync(join(home, ".config", "systemd", "user", SYSTEMD_UNIT), "utf8");
      assert.ok(!unit.includes(TOKEN));
      assert.deepEqual(calls(), [
        "systemctl --user daemon-reload",
        `systemctl --user enable --now ${SYSTEMD_UNIT}`,
        "loginctl enable-linger",
      ]);
    } else {
      assert.ok(calls().some((c) => c.startsWith("launchctl bootstrap gui/")));
    }

    const status = run(home, bin, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /running/);

    const removed = run(home, bin, ["uninstall-service"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.ok(!existsSync(secretFile));
    assert.equal(run(home, bin, ["status"]).status, 4);
  });

  it("rewrites the unit of an existing install with OOMPolicy=continue", {
    skip: platform() !== "linux",
  }, () => {
    const home = tmpDir("band-service-oom-");
    dirs.push(home);
    const { bin, calls } = stubBin(home);
    const unitFile = join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
    mkdirSync(join(unitFile, ".."), { recursive: true });
    // A unit an older Band wrote, without the policy.
    writeFileSync(unitFile, "[Unit]\nDescription=Band worker\n\n[Service]\nKillMode=process\n");
    const args = ["install-service", "--hub", "https://hub.example.com", "--token", TOKEN];
    for (let i = 0; i < 2; i++) {
      const before = calls().length;
      const install = run(home, bin, args);
      assert.equal(install.status, 0, install.stderr);
      const unit = readFileSync(unitFile, "utf8");
      const service = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
      assert.match(service, /^OOMPolicy=continue$/m);
      assert.equal(unit.match(/^OOMPolicy=continue$/gm)?.length, 1);
      assert.equal(unit.match(/^KillMode=process$/gm)?.length, 1);
      // systemd keeps the old unit until it reloads.
      assert.ok(calls().slice(before).includes("systemctl --user daemon-reload"));
    }
  });

  it("writes --env values into the service and refuses other names", { skip: !supported }, () => {
    const home = tmpDir("band-service-env-");
    dirs.push(home);
    const { bin } = stubBin(home);
    const base = ["install-service", "--hub", "https://hub.example.com", "--token", TOKEN];
    const refused = run(home, bin, [...base, "--env", "FOO=1"]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /FOO/);
    const ok = run(home, bin, [...base, "--env", "BAND_WORKER_HUB_GIT_CREDENTIALS_ONLY=1"]);
    assert.equal(ok.status, 0, ok.stderr);
    const file =
      platform() === "linux"
        ? join(home, ".band", "worker-service", "worker.env")
        : join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    assert.match(
      readFileSync(file, "utf8"),
      platform() === "linux"
        ? /BAND_WORKER_HUB_GIT_CREDENTIALS_ONLY="1"/
        : /<key>BAND_WORKER_HUB_GIT_CREDENTIALS_ONLY<\/key>\s*<string>1<\/string>/,
    );
  });

  it("refuses to install without a hub or token", () => {
    const home = tmpDir("band-service-");
    dirs.push(home);
    const { bin } = stubBin(home);
    const noToken = run(home, bin, ["install-service", "--hub", "https://hub.example.com"]);
    assert.equal(noToken.status, 2);
    assert.match(noToken.stderr, /--token/);
    const noHub = run(home, bin, ["install-service", "--token", TOKEN]);
    assert.equal(noHub.status, 2);
    assert.ok(!noHub.stderr.includes(TOKEN));
  });
});
