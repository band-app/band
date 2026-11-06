// The changed-file lists are those of real recent PRs (gh pr diff <n> --name-only).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { matrixFor, SMOKE_SPECS, selectSpecs } from "./affected-e2e.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const total = readdirSync(join(root, "apps/web/e2e")).filter((f) => f.endsWith(".spec.ts")).length;

const PRS = {
  1093: [
    "apps/web/e2e/pages/SelectionMenu.ts",
    "apps/web/e2e/pages/SidebarGroupsPage.ts",
    "apps/web/e2e/pages/TerminalLinkPopoverPage.ts",
    "apps/web/e2e/pages/WorktreePage.ts",
    "apps/web/e2e/ui-zoom-mouse-popups-drag.spec.ts",
    "apps/web/src/components/TerminalLinkPopover.tsx",
    "apps/web/src/dashboard/components/RepoList.tsx",
    "apps/web/src/dashboard/components/settings/GroupsSettings.tsx",
    "apps/web/src/lib/zoom.ts",
    "apps/web/src/styles/globals.css",
  ],
  1094: [
    "apps/desktop/src/preload/index.cts",
    "apps/web/e2e-desktop/desktop-chat-file-drop.spec.ts",
    "apps/web/e2e/chat-file-drop.spec.ts",
    "apps/web/e2e/pages/ChatPanePage.ts",
    "apps/web/src/client.tsx",
    "apps/web/src/components/ai-elements/prompt-input.tsx",
    "apps/web/src/lib/chat-file-drop.ts",
    "apps/web/src/lib/desktop-ipc.ts",
  ],
  1096: [
    "apps/web/e2e/file-iframe-keep-alive.spec.ts",
    "apps/web/e2e/pages/HtmlVisualPage.ts",
    "apps/web/src/components/WorktreeCenter.tsx",
    "apps/web/src/dashboard/components/PdfPreview.tsx",
  ],
  1097: [
    "apps/web/e2e/chat-dollar-math.spec.ts",
    "apps/web/e2e/pages/ChatPanePage.ts",
    "apps/web/package.json",
    "apps/web/src/components/streamdown-components.tsx",
    "apps/web/src/routes/__root.tsx",
    "pnpm-lock.yaml",
  ],
  1091: [
    "apps/mobile/e2e/c9-bubble-list.yaml",
    "apps/mobile/scripts/seed.mjs",
    "apps/mobile/src/components/chat/markdown.tsx",
  ],
};

const sizes = {};
for (const [n, files] of Object.entries(PRS)) {
  test(`PR ${n} selection`, () => {
    const r = selectSpecs(files);
    sizes[n] = `${r.mode} ${r.specs.length}/${total}`;
    console.log(`PR ${n}: ${r.mode}, ${r.specs.length} of ${total} specs (${r.reason})`);
    // Specs the PR added or changed always run. Some PRs' specs are not in this checkout.
    for (const f of files.filter((x) => /^apps\/web\/e2e\/[^/]+\.spec\.ts$/.test(x) && existsSync(join(root, x)))) {
      assert.ok(r.specs.includes(f), `${f} is selected`);
    }
    for (const s of SMOKE_SPECS) assert.ok(r.specs.includes(s), `${s} (smoke) is selected`);
  });
}

test("PR 1091 (mobile only) selects the smoke set and nothing else", () => {
  const r = selectSpecs(PRS[1091]);
  assert.equal(r.mode, "subset");
  assert.deepEqual(r.specs, [...SMOKE_SPECS].sort());
});

test("PR 1096 stays a subset and includes the spec that imports the changed page object", () => {
  const r = selectSpecs(PRS[1096]);
  assert.equal(r.mode, "subset");
  assert.ok(r.specs.includes("apps/web/e2e/html-visual-edit.spec.ts"));
});

test("a lockfile, hub or workflow change selects everything", () => {
  for (const f of ["pnpm-lock.yaml", "apps/hub/src/server/services/token-service.ts", ".github/workflows/ci.yml", "packages/shared/src/x.ts"]) {
    const r = selectSpecs([f]);
    assert.equal(r.mode, "all", f);
    assert.equal(r.specs.length, total);
  }
  assert.equal(selectSpecs(PRS[1097]).mode, "all");
});

test("a page object change selects every spec that imports it, directly or through another page", () => {
  const r = selectSpecs(["apps/web/e2e/pages/HtmlVisualPage.ts"]);
  const importers = execFileSync("grep", ["-l", "HtmlVisualPage", ...readdirSync(join(root, "apps/web/e2e")).filter((f) => f.endsWith(".spec.ts")).map((f) => join(root, "apps/web/e2e", f))], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((p) => p.slice(root.length));
  assert.ok(importers.length > 0);
  for (const s of importers) assert.ok(r.specs.includes(s), `${s} imports the page object`);
});

test("a helper change selects the specs that import it", () => {
  const r = selectSpecs(["apps/web/e2e/helpers/acp-stub.ts"]);
  assert.ok(r.specs.includes("apps/web/e2e/chat-cancel.spec.ts"));
});

test("an unmapped or empty change fails open to every spec", () => {
  assert.equal(selectSpecs([]).mode, "all");
  assert.equal(selectSpecs(["some-new-root-file.json"]).mode, "all");
  assert.equal(selectSpecs(["apps/web/src/lib/does-not-exist.ts"]).mode, "all");
});

test("shards: three for the full suite, one for a small subset", () => {
  assert.deepEqual(matrixFor({ mode: "all", specs: [] }), { shard: [1, 2, 3], total: [3] });
  assert.deepEqual(matrixFor({ mode: "subset", specs: ["a"] }), { shard: [1], total: [1] });
});

test("the script fails open on a broken input", () => {
  const out = execFileSync("node", [join(root, "scripts/ci/affected-e2e.mjs"), "--event", "pull_request", "--base", "nonexistent", "--head", "nonexistent"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.match(out, /affected-e2e: all/);
});

test("other events select everything", () => {
  const out = execFileSync("node", [join(root, "scripts/ci/affected-e2e.mjs"), "--event", "merge_group"], { encoding: "utf8" });
  assert.match(out, /affected-e2e: all \(merge_group runs every spec\)/);
});
