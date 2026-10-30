import type { SubscriptionContext } from "@band-app/plugin-api";
import type { BandServerApi } from "@band-app/plugin-api/server";
import { createSubscriptionSource } from "@band-app/plugin-github/subscriptions";
import { describe, expect, it } from "vitest";

const REPO = "acme/widgets";
/** The provider remembers this many branches; the test polls more than that. */
const BRANCHES = 520;

/** `gh` answers a branch's check-runs request with one finished check on a commit named by its branch. */
function context(shaOf: (branch: string) => string): SubscriptionContext {
  return {
    gh: async (args) => {
      const endpoint = args[1];
      const branch = decodeURIComponent(endpoint.split("/commits/")[1].split("/check-runs")[0]);
      return JSON.stringify({
        check_runs: [
          { name: "build", status: "completed", conclusion: "success", head_sha: shaOf(branch) },
        ],
      });
    },
    ghWithInput: async () => "",
    isBandPushed: () => false,
    callsLeft: () => 100,
  };
}

function setup(shaOf: (branch: string) => string = (b) => `sha-${b}`) {
  const signals: string[] = [];
  const api = {
    reviews: { changed: (t: { branch?: string }) => signals.push(t.branch ?? "") },
    log: { warn: () => {} },
  } as unknown as BandServerApi;
  const provider = createSubscriptionSource(api);
  const ctx = context(shaOf);
  const poll = async (branch: string) => {
    const results = await provider.poll(
      REPO,
      { id: `ci:${REPO}@${branch}`, subscriptions: [] },
      ctx,
    );
    return results.flatMap((r) => r.events.map((e) => e.id));
  };
  return { poll, signals };
}

// Direct-function test: the remembered verdicts are private to the provider and have no HTTP or
// database view. The observable is the `reviews.changed` call, plus the event id the core dedups on.
describe("the GitHub provider's memory of CI verdicts is bounded (S3)", () => {
  it("signals once per verdict while remembered, and forgets the oldest branches", async () => {
    const { poll, signals } = setup();
    for (let i = 0; i < BRANCHES; i++) await poll(`b${i}`);
    expect(signals).toHaveLength(BRANCHES);

    // A recent branch is remembered: polling it again is silent.
    await poll(`b${BRANCHES - 1}`);
    expect(signals).toHaveLength(BRANCHES);

    // The oldest was dropped to stay bounded, so it signals once more. The verdict it returns
    // carries the same event id as before, which the core dedups per subscription.
    const again = await poll("b0");
    expect(signals).toHaveLength(BRANCHES + 1);
    expect(again).toEqual(["ci:sha-b0:success"]);
    await poll("b0");
    expect(signals).toHaveLength(BRANCHES + 1);
  });

  it("signals again for a new commit on a remembered branch", async () => {
    let sha = "one";
    const { poll, signals } = setup(() => sha);
    expect(await poll("main")).toEqual(["ci:one:success"]);
    await poll("main");
    expect(signals).toHaveLength(1);
    sha = "two";
    expect(await poll("main")).toEqual(["ci:two:success"]);
    expect(signals).toHaveLength(2);
  });
});
