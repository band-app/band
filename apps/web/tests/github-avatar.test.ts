// Pure-function coverage for the host rules behind GitHub project avatars.
// The end-to-end behaviour (fetch, cache, fallback) is covered through the
// real server in `project-avatars.test.ts`; GitHub Enterprise hosts cannot be
// reached from a test, so which hosts count as GitHub is pinned here, in the
// same direct style as the `parseGitRemoteUrl` tests in `github-graphql.test.ts`.

import { afterEach, describe, expect, it } from "vitest";
import { parseGitRemoteUrl } from "../src/server/infra/git/git-client";
import { githubAvatarUrl, githubRepoRef } from "../src/server/services/_utils/github-avatar";

const ref = (url: string) => githubRepoRef(parseGitRemoteUrl(url));

describe("githubRepoRef", () => {
  it("accepts github.com over HTTPS, SCP-style SSH, ssh:// and its aliases", () => {
    const expected = { host: "github.com", owner: "acme", repo: "widgets" };
    expect(ref("https://github.com/acme/widgets.git")).toEqual(expected);
    expect(ref("git@github.com:acme/widgets.git")).toEqual(expected);
    expect(ref("ssh://git@github.com/acme/widgets")).toEqual(expected);
    expect(ref("ssh://git@ssh.github.com:443/acme/widgets.git")).toEqual(expected);
    expect(ref("https://www.github.com/acme/widgets")).toEqual(expected);
    expect(ref("https://GitHub.com/acme/widgets")).toEqual(expected);
  });

  it("accepts GitHub Enterprise hosts named github.<domain> or <name>.ghe.com", () => {
    expect(ref("git@github.example.com:platform/api.git")).toEqual({
      host: "github.example.com",
      owner: "platform",
      repo: "api",
    });
    expect(ref("https://octo.ghe.com/team/app.git")).toEqual({
      host: "octo.ghe.com",
      owner: "team",
      repo: "app",
    });
  });

  it("rejects other hosts, missing remotes, and owners that are not GitHub logins", () => {
    expect(ref("https://gitlab.com/acme/widgets.git")).toBeNull();
    expect(ref("git@bitbucket.org:acme/widgets.git")).toBeNull();
    expect(ref("https://git.example.com/acme/widgets.git")).toBeNull();
    expect(githubRepoRef(null)).toBeNull();
    expect(githubRepoRef({ host: "github.com", owner: "..", repo: "x" })).toBeNull();
    expect(githubRepoRef({ host: "github.com", owner: "a.b", repo: "x" })).toBeNull();
  });
});

describe("githubAvatarUrl", () => {
  const saved = process.env.BAND_GITHUB_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.BAND_GITHUB_URL;
    else process.env.BAND_GITHUB_URL = saved;
  });

  it("uses github.com, or BAND_GITHUB_URL when set", () => {
    delete process.env.BAND_GITHUB_URL;
    expect(githubAvatarUrl({ host: "github.com", owner: "acme" })).toBe(
      "https://github.com/acme.png?size=64",
    );
    process.env.BAND_GITHUB_URL = "http://127.0.0.1:9999/";
    expect(githubAvatarUrl({ host: "github.com", owner: "acme" })).toBe(
      "http://127.0.0.1:9999/acme.png?size=64",
    );
  });

  it("serves GitHub Enterprise avatars from the enterprise host", () => {
    process.env.BAND_GITHUB_URL = "http://127.0.0.1:9999";
    expect(githubAvatarUrl({ host: "github.example.com", owner: "platform" })).toBe(
      "https://github.example.com/platform.png?size=64",
    );
  });
});
