import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanEnv } from "../scripts/hub.mjs";

test("a test hub inherits none of a worker's git credential helper", () => {
  const env = cleanEnv({
    PATH: "/usr/bin",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!/Applications/Band.app/Contents/MacOS/Band x git-credential",
    GIT_CONFIG_PARAMETERS: "'a=b'",
    GIT_ASKPASS: "/x",
    SSH_ASKPASS: "/y",
    GH_TOKEN: "t",
    BAND_GIT_CREDENTIAL_SOCK: "/s",
    BAND_TOKEN: "t",
  });
  assert.deepEqual(env, { PATH: "/usr/bin" });
});
