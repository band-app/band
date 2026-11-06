// Runs scripts/ci/install-playwright.sh with fake sudo-less `apt-get`, `dpkg`
// and `playwright` commands on PATH, against temp directories.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../install-playwright.sh",
);

function setup({ aptBody }) {
  const root = mkdtempSync(path.join(tmpdir(), "install-pw-"));
  const bin = path.join(root, "bin");
  const archives = path.join(root, "archives");
  const debCache = path.join(root, "deb-cache");
  mkdirSync(bin);
  mkdirSync(archives);
  const exe = (name, body) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  };
  exe(
    "playwright",
    `if [ "$1" = install-deps ]; then
  echo "sudo apt-get install -y --no-install-recommends libfoo1 libbar2 libbaz3"
fi
exit 0`,
  );
  exe("dpkg", "exit 0");
  exe("apt-get", `echo "$*" >> "${root}/apt.log"\n${aptBody(archives, root)}`);
  const run = (args, env = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SUDO: "",
        FORCE_APT: "1",
        PLAYWRIGHT_CMD: path.join(bin, "playwright"),
        APT_ARCHIVES_DIR: archives,
        DPKG_LOCK_FILES: "",
        INSTALL_BACKOFF_SECONDS: "0",
        APT_SOURCES_FILES: "",
        ...env,
      },
    });
  return { root, archives, debCache, run };
}

// A fake apt-get that adds one .deb per `--download-only` call.
const oneDebPerCall = (archives) => `
case "$*" in
  *--download-only*)
    n=$(ls "${archives}" | wc -l)
    touch "${archives}/pkg$((n + 1)).deb"
    ;;
esac
exit 0`;

describe("install-playwright.sh", () => {
  it("--plan prints a hash that follows the package list", () => {
    const a = setup({ aptBody: () => "exit 0" });
    const first = a.run(["--plan", "chromium"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^apt-packages-hash=[0-9a-f]{64}\n$/);
    assert.deepEqual(a.run(["--plan", "chromium"]).stdout, first.stdout);
    writeFileSync(
      path.join(a.root, "bin", "playwright"),
      `#!/usr/bin/env bash\necho "apt-get install -y libfoo1 libnew9"\n`,
    );
    assert.notEqual(a.run(["--plan", "chromium"]).stdout, first.stdout);
  });

  it("saves the downloaded .debs to the cache dir after the install (S1)", () => {
    const a = setup({ aptBody: oneDebPerCall });
    const result = a.run(["chromium"], { APT_DEB_CACHE_DIR: a.debCache });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(a.debCache), ["pkg1.deb"]);
  });

  it("downloads nothing new when the cache holds the packages (S2)", () => {
    const a = setup({
      aptBody: (archives) => `
case "$*" in
  *--download-only*) [ -e "${archives}/pkg1.deb" ] || touch "${archives}/new.deb" ;;
esac
exit 0`,
    });
    mkdirSync(a.debCache);
    writeFileSync(path.join(a.debCache, "pkg1.deb"), "");
    const result = a.run(["chromium"], { APT_DEB_CACHE_DIR: a.debCache });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(path.join(a.archives, "pkg1.deb")));
    assert.ok(!existsSync(path.join(a.archives, "new.deb")));
    assert.match(result.stdout, /download attempt 1 /);
    assert.doesNotMatch(result.stdout, /download attempt 2/);
  });

  it("keeps retrying while attempts add packages (S3)", () => {
    // Three slow attempts each add a .deb and run past the cap; the fourth finishes.
    const a = setup({
      aptBody: (archives) => `
case "$*" in
  *--download-only*)
    n=$(ls "${archives}" | wc -l)
    touch "${archives}/pkg$((n + 1)).deb"
    [ "$n" -ge 3 ] && exit 0
    sleep 5
    ;;
esac
exit 0`,
    });
    const result = a.run(["chromium"], {
      APT_DOWNLOAD_TIMEOUT_SECONDS: "1",
      APT_DOWNLOAD_BUDGET_SECONDS: "600",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /download attempt 4 /);
  });

  it("stops at the time budget while still progressing (S3)", () => {
    const a = setup({
      aptBody: (archives) => `
case "$*" in
  *--download-only*)
    n=$(ls "${archives}" | wc -l)
    touch "${archives}/pkg$((n + 1)).deb"
    sleep 5
    ;;
esac
exit 0`,
    });
    const result = a.run(["chromium"], {
      APT_DOWNLOAD_TIMEOUT_SECONDS: "1",
      APT_DOWNLOAD_BUDGET_SECONDS: "2",
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /still progressing .* time budget/);
  });

  it("gives up after an attempt with no progress (S3)", () => {
    const a = setup({
      aptBody: () => `case "$*" in *--download-only*) sleep 5 ;; esac\nexit 0`,
    });
    const result = a.run(["chromium"], {
      APT_DOWNLOAD_TIMEOUT_SECONDS: "1",
      APT_DOWNLOAD_BUDGET_SECONDS: "600",
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /made no progress/);
    assert.doesNotMatch(result.stdout, /download attempt 2/);
  });

  it("switches azure to archive.ubuntu.com in every source format on retry (S4)", () => {
    const a = setup({
      aptBody: (archives) => `
case "$*" in
  *--download-only*)
    if [ ! -e "${archives}/pkg1.deb" ]; then touch "${archives}/pkg1.deb"; exit 1; fi
    ;;
esac
exit 0`,
    });
    const files = {
      "apt-mirrors.txt": "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n",
      "ubuntu.sources":
        "Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble\n",
      "sources.list": "deb http://azure.archive.ubuntu.com/ubuntu noble main\n",
    };
    const paths = Object.entries(files).map(([name, text]) => {
      const file = path.join(a.root, name);
      writeFileSync(file, text);
      return file;
    });
    const result = a.run(["chromium"], { APT_SOURCES_FILES: paths.join(" ") });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const file of paths) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /azure/, file);
      assert.match(text, /\/\/archive\.ubuntu\.com/, file);
    }
  });
});
