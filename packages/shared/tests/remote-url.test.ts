import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRemoteUrl, parseRemoteUrl, stripUrlCredentials } from "../src/remote-url.ts";

test("every spelling of one remote gives one key", () => {
  const spellings = [
    "git@github.com:o/r.git",
    "git@github.com:o/r",
    "https://github.com/o/r",
    "https://github.com/o/r.git",
    "https://GitHub.com/o/r/",
    "ssh://git@github.com/o/r.git",
    "ssh://git@github.com:22/o/r.git",
    "git://github.com/o/r.git",
    "https://user:token@github.com/o/r.git",
  ];
  for (const s of spellings) assert.equal(normalizeRemoteUrl(s), "github.com/o/r", s);
});

test("different repositories keep different keys", () => {
  assert.notEqual(
    normalizeRemoteUrl("git@github.com:o/r.git"),
    normalizeRemoteUrl("git@gitlab.com:o/r.git"),
  );
  assert.notEqual(
    normalizeRemoteUrl("https://github.com/o/a"),
    normalizeRemoteUrl("https://github.com/o/b"),
  );
});

test("local paths and file URLs share a key", () => {
  assert.equal(normalizeRemoteUrl("/tmp/x/remote.git"), "file:///tmp/x/remote");
  assert.equal(normalizeRemoteUrl("file:///tmp/x/remote.git"), "file:///tmp/x/remote");
});

test("credentials never survive in the clone URL", () => {
  assert.equal(
    stripUrlCredentials("https://user:secret@github.com/o/r.git"),
    "https://github.com/o/r.git",
  );
  assert.equal(parseRemoteUrl("https://tok@github.com/o/r")?.url.includes("tok"), false);
  assert.equal(stripUrlCredentials("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.equal(stripUrlCredentials("ssh://git:pw@github.com/o/r"), "ssh://git@github.com/o/r");
});

test("a URL with no owner segment still has an identity", () => {
  assert.equal(normalizeRemoteUrl("http://127.0.0.1:8123/proj.git"), "127.0.0.1:8123/proj");
});

test("rejects things that are not remotes", () => {
  assert.equal(normalizeRemoteUrl(""), null);
  assert.equal(normalizeRemoteUrl("not a url"), null);
  assert.equal(normalizeRemoteUrl("https://github.com/"), null);
});

test("refuses paths that climb out of the clone folder and option-like input", () => {
  assert.equal(parseRemoteUrl("git@h:../../x/y"), null);
  assert.equal(parseRemoteUrl("https://h/a%2F..%2F..%2Fetc/x"), null);
  assert.equal(parseRemoteUrl("git@h:o/.."), null);
  assert.equal(parseRemoteUrl("-oProxyCommand=x:o/r"), null);
  assert.equal(parseRemoteUrl("ext::sh -c id"), null);
  assert.equal(parseRemoteUrl("https://h/%E0%A4%A/r"), null);
});

test("drops a query string and fragment from a web URL", () => {
  assert.equal(parseRemoteUrl("https://h/o/r?token=x#f")?.url, "https://h/o/r");
});
