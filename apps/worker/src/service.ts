import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, parseLabels } from "./config.ts";
import { stopTerminalDaemons } from "./terminals.ts";

export const SERVICE_SUBCOMMANDS = ["install-service", "uninstall-service", "status"] as const;
export type ServiceSubcommand = (typeof SERVICE_SUBCOMMANDS)[number];

export const SYSTEMD_UNIT = "band-worker.service";
export const LAUNCHD_LABEL = "app.band.worker";

export interface ServiceOptions {
  hub: string;
  token: string;
  name?: string;
  labels?: string;
  roots: string[];
  stateDir?: string;
  workerId?: string;
}

export type Runner = (cmd: string, args: string[]) => string;

export interface ServiceEnv {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  /** Absolute path of the node binary and of the band-worker entry script the service runs. */
  node: string;
  script: string;
  run: Runner;
  log: (line: string) => void;
}

export function defaultServiceEnv(): ServiceEnv {
  return {
    platform: osPlatform(),
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    node: process.execPath,
    script: realpathSync(process.argv[1] ?? ""),
    run: (cmd, args) =>
      execFileSync(cmd === "launchctl" ? (process.env.BAND_LAUNCHCTL_BIN ?? cmd) : cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

const USAGE = `Usage: band-worker install-service --hub <url> --token <bootstrap token> [options]
       band-worker uninstall-service
       band-worker status

  --hub <url>        Hub URL. Plain http is accepted only for loopback.
  --token <token>    One-time bootstrap token from Settings > Hosts (env BAND_WORKER_TOKEN).
  --root <dir>       Directory the worker may serve. Repeatable.
  --name <name>      Display name.
  --labels k=v,...   Placement labels.
  --worker-id <id>   The id the hub issued with the token.
  --state-dir <dir>  Where the worker keeps its id and session token.
`;

export function serviceUsage(): string {
  return USAGE;
}

export function parseServiceOptions(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ServiceOptions {
  let values: ReturnType<typeof parse>["values"];
  try {
    values = parse(argv).values;
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  const hub = values.hub ?? env.BAND_HUB_URL;
  if (!hub) throw new ConfigError("--hub (or BAND_HUB_URL) is required");
  const token = values.token ?? env.BAND_WORKER_TOKEN ?? env.BAND_BOOTSTRAP_TOKEN;
  if (!token) throw new ConfigError("--token (or BAND_WORKER_TOKEN) is required");
  if (values.labels) parseLabels(values.labels);
  return {
    hub,
    token,
    name: values.name,
    labels: values.labels,
    roots: (values.root ?? []).map((r) => resolve(r)),
    stateDir: values["state-dir"] ? resolve(values["state-dir"]) : undefined,
    workerId: values["worker-id"],
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      hub: { type: "string" },
      token: { type: "string" },
      name: { type: "string" },
      labels: { type: "string" },
      root: { type: "string", multiple: true },
      "state-dir": { type: "string" },
      "worker-id": { type: "string" },
    },
    strict: true,
  });
}

/** The variables the service gives the worker, in the names `parseConfig` reads. */
export function serviceVariables(opts: ServiceOptions): Record<string, string> {
  const vars: Record<string, string> = {
    BAND_HUB_URL: opts.hub,
    BAND_WORKER_TOKEN: opts.token,
  };
  if (opts.workerId) vars.BAND_WORKER_ID = opts.workerId;
  if (opts.name) vars.BAND_WORKER_NAME = opts.name;
  if (opts.labels) vars.BAND_WORKER_LABELS = opts.labels;
  if (opts.roots.length > 0) vars.BAND_WORKER_ROOTS = opts.roots.join(delimiter);
  if (opts.stateDir) vars.BAND_WORKER_STATE_DIR = opts.stateDir;
  return vars;
}

/** systemd's EnvironmentFile syntax: `KEY="value"` with backslash and double quote escaped. */
export function renderEnvFile(vars: Record<string, string>): string {
  return `${Object.entries(vars)
    .map(([k, v]) => `${k}="${v.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n")}"`)
    .join("\n")}\n`;
}

function systemdQuote(arg: string): string {
  return `"${arg.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;
}

export function renderSystemdUnit(opts: { node: string; script: string; envFile: string }): string {
  return `[Unit]
Description=Band worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${opts.envFile}
ExecStart=${systemdQuote(opts.node)} ${systemdQuote(opts.script)}
Restart=always
RestartSec=5
# Stopping or restarting the worker must not end the terminals' shells, which run in their own daemon.
KillMode=process

[Install]
WantedBy=default.target
`;
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderLaunchdPlist(opts: {
  node: string;
  script: string;
  vars: Record<string, string>;
  logFile: string;
}): string {
  const env = Object.entries(opts.vars)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.node)}</string>
    <string>${xml(opts.script)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(opts.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.logFile)}</string>
</dict>
</plist>
`;
}

export interface ServicePaths {
  serviceDir: string;
  envFile: string;
  unitFile: string;
  plistFile: string;
  logFile: string;
}

export function servicePaths(env: Pick<ServiceEnv, "home">): ServicePaths {
  const serviceDir = join(env.home, ".band", "worker-service");
  return {
    serviceDir,
    envFile: join(serviceDir, "worker.env"),
    unitFile: join(env.home, ".config", "systemd", "user", SYSTEMD_UNIT),
    plistFile: join(env.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    logFile: join(serviceDir, "worker.log"),
  };
}

/** Writes a file readable by its owner only, even when it already existed with other permissions. */
function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function ensureDir(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

function unsupported(platform: NodeJS.Platform): never {
  throw new ConfigError(
    `install-service supports Linux (systemd) and macOS (launchd), not ${platform}`,
  );
}

export function installService(opts: ServiceOptions, env: ServiceEnv): void {
  const paths = servicePaths(env);
  const vars = serviceVariables(opts);
  // Inside the desktop app `node` is the Band executable, which only runs a script with this set.
  if (process.versions.electron) vars.ELECTRON_RUN_AS_NODE = "1";
  ensureDir(join(env.home, ".band"), 0o700);
  ensureDir(paths.serviceDir, 0o700);

  if (env.platform === "linux") {
    writePrivate(paths.envFile, renderEnvFile(vars));
    mkdirSync(join(paths.unitFile, ".."), { recursive: true });
    writeFileSync(
      paths.unitFile,
      renderSystemdUnit({ node: env.node, script: env.script, envFile: paths.envFile }),
    );
    env.run("systemctl", ["--user", "daemon-reload"]);
    env.run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    try {
      env.run("loginctl", ["enable-linger"]);
    } catch {
      env.log(
        "Could not enable linger, so the worker stops when you log out. Run: sudo loginctl enable-linger $USER",
      );
    }
    env.log(`Installed ${SYSTEMD_UNIT}. Check it with: band-worker status`);
    return;
  }
  if (env.platform === "darwin") {
    mkdirSync(join(paths.plistFile, ".."), { recursive: true });
    // The plist carries the token, so it gets the same permissions as the env file does on Linux.
    writePrivate(
      paths.plistFile,
      renderLaunchdPlist({ node: env.node, script: env.script, vars, logFile: paths.logFile }),
    );
    const domain = `gui/${env.uid}`;
    try {
      env.run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    } catch {
      // Not loaded yet.
    }
    env.run("launchctl", ["bootstrap", domain, paths.plistFile]);
    env.log(`Installed ${LAUNCHD_LABEL}. Check it with: band-worker status`);
    return;
  }
  unsupported(env.platform);
}

/** The state dir the installed service uses: the one in its env file, else the default under BAND_HOME. */
function installedStateDir(env: ServiceEnv, envFile: string): string {
  try {
    const match = /^BAND_WORKER_STATE_DIR="((?:[^"\\]|\\.)*)"$/m.exec(
      readFileSync(envFile, "utf8"),
    );
    if (match) return match[1].replace(/\\(.)/g, "$1");
  } catch {
    // No env file: the service was never installed, or its file is gone.
  }
  return join(process.env.BAND_HOME ?? join(env.home, ".band"), "worker");
}

export function uninstallService(env: ServiceEnv): void {
  const paths = servicePaths(env);
  const stateDir = installedStateDir(env, paths.envFile);
  if (env.platform === "linux") {
    try {
      env.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    } catch {
      // Not installed or not running.
    }
    rmSync(paths.unitFile, { force: true });
    rmSync(paths.envFile, { force: true });
    try {
      env.run("systemctl", ["--user", "daemon-reload"]);
    } catch {
      // No user manager.
    }
  } else if (env.platform === "darwin") {
    try {
      env.run("launchctl", ["bootout", `gui/${env.uid}/${LAUNCHD_LABEL}`]);
    } catch {
      // Not loaded.
    }
    rmSync(paths.plistFile, { force: true });
  } else {
    unsupported(env.platform);
  }
  // The terminals run in their own daemon, which the service manager does not stop (see `KillMode=process`).
  const ended = stopTerminalDaemons(stateDir);
  if (ended > 0) env.log("Ended the terminal daemon and its shells.");
  env.log("Removed the band-worker service. The worker's state directory is kept.");
}

/** Prints the service state and returns the exit code: 0 running, 3 installed but not running, 4 not installed. */
export function serviceStatus(env: ServiceEnv): number {
  const paths = servicePaths(env);
  const file = env.platform === "darwin" ? paths.plistFile : paths.unitFile;
  if (env.platform !== "linux" && env.platform !== "darwin") unsupported(env.platform);
  if (!existsSync(file)) {
    env.log("band-worker service is not installed");
    return 4;
  }
  try {
    if (env.platform === "linux") {
      env.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
    } else {
      env.run("launchctl", ["print", `gui/${env.uid}/${LAUNCHD_LABEL}`]);
    }
  } catch {
    env.log("band-worker service is installed but not running");
    return 3;
  }
  env.log("band-worker service is running");
  return 0;
}
