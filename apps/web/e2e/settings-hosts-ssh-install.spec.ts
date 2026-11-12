/**
 * Settings > Workers > Add worker > "Over ssh", driven through the real dialog against the real
 * server. The hub finds stub `ssh` and `ssh-keyscan` scripts through BAND_SSH_BIN and
 * BAND_SSH_KEYSCAN_BIN; ssh-keygen is the real one, on temp files. The stub ssh fails the way
 * ssh does when it needs input, so the install ends in the error popover. The hub test
 * `apps/hub/tests/ssh-install.test.ts` covers the install that succeeds. No test connects to a
 * host or reads the real ~/.ssh: the hub's HOME is a temp dir.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-ssh-install-token";

let server: ServerHandle;
let tmpHome: string;
let stubs: string;

const calls = () => {
  const file = join(stubs, "ssh-calls");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  stubs = realpathSync(mkdtempSync(join(tmpdir(), "band-e2e-ssh-")));
  seedSettings(tmpHome, { tokenSecret: TOKEN });

  mkdirSync(join(tmpHome, ".ssh"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".ssh", "config"),
    `Include extra.conf

Host colima
  User amir
  HostName 192.168.5.15

Host rc-preview
  HostName preview.example.com

Host *
  ServerAliveInterval 30
`,
  );
  writeFileSync(
    join(tmpHome, ".ssh", "extra.conf"),
    "Host included-box\n  User ops\n  HostName box.example.com\n",
  );

  mkdirSync(join(stubs, "hostkeys"));
  const keyFile = join(stubs, "key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "t", "-f", keyFile]);
  const [type, blob] = readFileSync(`${keyFile}.pub`, "utf8").trim().split(" ");
  writeFileSync(join(stubs, "hostkeys", "colima"), `${type} ${blob}\n`);

  writeFileSync(
    join(stubs, "ssh"),
    `#!/bin/sh
if [ "$1" = "-G" ]; then
  target="$3"; host="\${target#*@}"
  echo "hostname $host"
  echo "port 22"
  echo "userknownhostsfile ${tmpHome}/.ssh/known_hosts"
  echo "globalknownhostsfile /nonexistent/known_hosts"
  exit 0
fi
echo "install $*" >>"${stubs}/ssh-calls"
echo "Permission denied (publickey)." >&2
exit 255
`,
  );
  writeFileSync(
    join(stubs, "ssh-keyscan"),
    `#!/bin/sh
for host; do :; done
file="${stubs}/hostkeys/$host"
[ -f "$file" ] || { echo "no route to host" >&2; exit 1; }
echo "$host $(cat "$file")"
`,
  );
  chmodSync(join(stubs, "ssh"), 0o755);
  chmodSync(join(stubs, "ssh-keyscan"), 0o755);

  server = await startServer({
    tmpHome,
    env: {
      BAND_SSH_BIN: join(stubs, "ssh"),
      BAND_SSH_KEYSCAN_BIN: join(stubs, "ssh-keyscan"),
    },
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(stubs, { recursive: true, force: true });
});

test("lists the ssh config hosts of the picked worker (S1, S8)", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  await settingsPage.openSshInstall();

  // A browser has no "this computer" worker, so the dialog asks which worker runs ssh.
  await expect(settingsPage.sshWorkerPicker()).toBeVisible();
  await expect(settingsPage.sshHostRows()).toHaveCount(3);
  await expect(settingsPage.sshHostRow("colima")).toContainText("amir@192.168.5.15");
  await expect(settingsPage.sshHostRow("rc-preview")).toBeVisible();
  await expect(settingsPage.sshHostRow("included-box")).toContainText("ops@box.example.com");
});

test("refuses a bad typed target with an error popover (S2)", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  await settingsPage.openSshInstall();

  await settingsPage.installOnTypedTarget("-oProxyCommand=x");
  await settingsPage.sshErrorIcon().click();
  await expect(settingsPage.sshErrorMessage()).toContainText("not a valid ssh target");
  expect(calls()).toEqual([]);
});

test("asks to confirm a new host key, then shows ssh's message and the hint (S3, S5)", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  await settingsPage.openSshInstall();

  await settingsPage.installOnSshHost("colima");
  await expect(settingsPage.sshFingerprints().first()).toContainText("SHA256:");
  expect(calls()).toEqual([]);

  await settingsPage.cancelSshHostKey();
  await expect(settingsPage.sshConfirmPanel()).toBeHidden();
  expect(calls()).toEqual([]);

  await settingsPage.installOnSshHost("colima");
  await settingsPage.confirmSshHostKey();
  await expect(settingsPage.sshStatus()).toHaveAttribute("data-status", "failed", {
    timeout: 20_000,
  });
  await settingsPage.sshRunErrorIcon().click();
  await expect(settingsPage.sshRunErrorMessage()).toContainText("Permission denied (publickey)");
  await expect(settingsPage.sshRunErrorMessage()).toContainText("ssh-agent");
  expect(calls()).toHaveLength(1);
});
