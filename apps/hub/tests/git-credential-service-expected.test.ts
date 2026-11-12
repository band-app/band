// Tests how GitCredentialService decides which remotes a worker may get a credential for. The
// service runs in-process against an empty temp BAND_HOME, so no repo is placed on any worker and
// only an announced remote (`expectRemote`) can be allowed. The token source is a stub that hands
// out one fixed credential, which is the vault's side of the exchange, not the service under test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METHOD_GIT_CREDENTIAL } from "@band-app/link";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";

type Handler = (params: unknown) => Promise<{ found: boolean; password?: string }>;

let tmp: string;
let originalBandHome: string | undefined;
let service: import("../src/server/services/git-credential-service").GitCredentialService;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "band-gitcred-unit-"));
  originalBandHome = process.env.BAND_HOME;
  process.env.BAND_HOME = join(tmp, ".band");
  const mod = await import("../src/server/services/git-credential-service");
  service = new mod.GitCredentialService({
    lookup: async () => ({ username: "u", password: "secret" }),
  } as never);
});

afterAll(() => {
  closeDb();
  if (originalBandHome !== undefined) process.env.BAND_HOME = originalBandHome;
  else delete process.env.BAND_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

/** What git on the worker gets when it asks the hub for `path` on github.com. */
async function ask(workerId: string, path: string): Promise<"granted" | "refused"> {
  const handlers = new Map<string, Handler>();
  service.attach({
    workerId,
    handle: (method: string, fn: Handler) => handlers.set(method, fn),
  } as never);
  try {
    const reply = await handlers.get(METHOD_GIT_CREDENTIAL)?.({
      protocol: "https",
      host: "github.com",
      path,
    });
    return reply?.password === "secret" ? "granted" : "refused";
  } catch (err) {
    expect(String(err instanceof Error ? err.message : err)).toContain("not placed on this worker");
    return "refused";
  }
}

describe("the remotes a worker may get a credential for", () => {
  it("refuses a repository the hub did not ask the worker to clone (S3)", async () => {
    service.expectRemote("w-a", "https://github.com/acme/widgets.git", "widgets");
    expect(await ask("w-b", "acme/widgets.git")).toBe("refused");
    expect(await ask("w-a", "acme/other.git")).toBe("refused");
  });

  it("allows an announced remote until it is withdrawn, and not after (S4)", async () => {
    const withdraw = service.expectRemote("w-c", "https://github.com/acme/clone.git", "clone");
    expect(await ask("w-c", "acme/clone.git")).toBe("granted");
    withdraw();
    expect(await ask("w-c", "acme/clone.git")).toBe("refused");
    withdraw();
  });

  it("withdraws one announcement and keeps the worker's others (S4)", async () => {
    const runner = service.expectRemote("w-d", "https://github.com/acme/runner.git", "runner");
    const clone = service.expectRemote("w-d", "https://github.com/acme/clone2.git", "clone2");
    clone();
    expect(await ask("w-d", "acme/clone2.git")).toBe("refused");
    expect(await ask("w-d", "acme/runner.git")).toBe("granted");
    runner();
    expect(await ask("w-d", "acme/runner.git")).toBe("refused");
  });

  it("forget still drops every announcement of a worker", async () => {
    service.expectRemote("w-e", "https://github.com/acme/a.git", "a");
    service.expectRemote("w-e", "https://github.com/acme/b.git", "b");
    service.forget("w-e");
    expect(await ask("w-e", "acme/a.git")).toBe("refused");
    expect(await ask("w-e", "acme/b.git")).toBe("refused");
  });
});
