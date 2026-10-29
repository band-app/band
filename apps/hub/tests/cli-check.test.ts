/**
 * `cli.check` and `cli.install` against a real server. `BAND_CLI_PATH` names the binary the hub
 * resolves and `BAND_CLI_SYMLINK_PATH` moves the install link into a temp dir, so nothing
 * touches `/usr/local/bin`.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";

const ADMIN = "cli-check-admin-token";

interface Check {
  status: string;
  applicable: boolean;
}

describe("cli.check", () => {
  let dir: string;
  let resolved: string;
  let foreign: string;
  let link: string;
  const homes: string[] = [];
  const servers: ServerHandle[] = [];

  async function boot(env: Record<string, string> = {}): Promise<ServerHandle> {
    const home = createTmpHome("band-cli-check-");
    homes.push(home);
    seedSettings(home, { tokenSecret: ADMIN });
    const server = await startServer({
      tmpHome: home,
      env: { BAND_CLI_PATH: resolved, BAND_CLI_SYMLINK_PATH: link, ...env },
      remoteHost: false,
    });
    servers.push(server);
    return server;
  }

  async function check(server: ServerHandle, token = ADMIN): Promise<Check> {
    const res = await trpcQuery(server.url, "cli.check", undefined, token);
    expect(res.status).toBe(200);
    return trpcData<Check>(res);
  }

  function relink(target: string): void {
    rmSync(link, { force: true });
    symlinkSync(target, link);
  }

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "band-cli-check-")));
    resolved = join(dir, "pkg", "bin", "band");
    foreign = join(dir, "other", "band");
    link = join(dir, "usr-local-bin", "band");
    for (const file of [resolved, foreign]) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "#!/bin/sh\n");
      chmodSync(file, 0o755);
    }
    mkdirSync(join(link, ".."), { recursive: true });
  });

  afterAll(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const h of homes.splice(0)) removeTmpHome(h);
    rmSync(dir, { recursive: true, force: true });
  });

  it("S1: a link to the binary the hub resolved is Installed, also through another link", async () => {
    const server = await boot();
    relink(resolved);
    expect((await check(server)).status).toBe("Installed");
    const via = join(dir, "via");
    rmSync(via, { force: true });
    symlinkSync(resolved, via);
    relink(via);
    expect((await check(server)).status).toBe("Installed");
  });

  it("S1: a link to an unrelated binary is still a conflict", async () => {
    const server = await boot();
    relink(foreign);
    expect((await check(server)).status).toBe("ConflictingBinary");
  });

  it("S3: a hub with no local worker has nothing to install for anyone", async () => {
    const server = await boot({ BAND_LOCAL_WORKER: "off" });
    expect((await check(server)).applicable).toBe(false);
  });

  it("S3: on a hub that runs worktrees, only an admin token is asked", async () => {
    const server = await boot();
    expect((await check(server)).applicable).toBe(true);
    const created = await trpcData<{ token: string }>(
      await trpcMutate(server.url, "tokens.createDevice", { label: "phone" }, ADMIN),
    );
    expect((await check(server, created.token)).applicable).toBe(false);
    const install = await trpcMutate(server.url, "cli.install", {}, created.token);
    expect(install.status).toBe(403);
  });

  it("an unauthenticated call is refused", async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/trpc/cli.check`);
    expect(res.status).toBe(401);
  });

  it("a non-admin token cannot read the install paths", async () => {
    const server = await boot();
    const created = await trpcData<{ token: string }>(
      await trpcMutate(server.url, "tokens.createDevice", { label: "tablet" }, ADMIN),
    );
    const res = await trpcQuery(server.url, "cli.resolve", undefined, created.token);
    expect(res.status).toBe(403);
  });

  it("S5: an install the hub cannot write names the machine", async () => {
    const server = await boot({ BAND_CLI_SYMLINK_PATH: join(dir, "missing-dir", "band") });
    const res = await trpcMutate(server.url, "cli.install", {}, ADMIN);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error: { message: string } };
    // On macOS the hub asks the desktop shell to elevate; elsewhere it names the server.
    expect(body.error.message).toMatch(/On the hub's server, run: sudo ln -sf|elevation-required/);
  });
});
