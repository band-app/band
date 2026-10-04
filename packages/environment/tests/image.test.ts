import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commitArgs,
  devcontainerBuildArgs,
  dockerBuildArgs,
  imageKey,
  imageTag,
  installCreateArgs,
  keyInputs,
  scrubEnv,
  workerLayerDockerfile,
} from "../src/index.ts";

describe("imageKey", () => {
  const base = {
    files: { "pnpm-lock.yaml": "aaa", ".band/environment.json": "bbb" },
    workerBase: "sha256:w1",
  };

  it("is stable and ignores the order of files", () => {
    const reordered = {
      ...base,
      files: { ".band/environment.json": "bbb", "pnpm-lock.yaml": "aaa" },
    };
    assert.equal(imageKey(base), imageKey(reordered));
    assert.match(imageKey(base), /^[0-9a-f]{64}$/);
  });

  it("changes with a lockfile, the worker base or the named image", () => {
    const key = imageKey(base);
    assert.notEqual(key, imageKey({ ...base, files: { ...base.files, "pnpm-lock.yaml": "ccc" } }));
    assert.notEqual(key, imageKey({ ...base, workerBase: "sha256:w2" }));
    assert.notEqual(key, imageKey({ ...base, image: "node:24" }));
  });
});

describe("keyInputs", () => {
  it("hashes a dockerfile and its directory", () => {
    const paths = keyInputs({ build: { dockerfile: "docker/dev/Dockerfile" } }).map((i) => i.path);
    assert.ok(paths.includes(".band/environment.json"));
    assert.ok(paths.includes("docker/dev/Dockerfile"));
    assert.ok(paths.includes("docker/dev"));
    assert.ok(paths.includes("pnpm-lock.yaml"));
  });

  it("hashes only the file and .dockerignore for a root dockerfile", () => {
    const inputs = keyInputs({ build: { dockerfile: "Dockerfile" } });
    assert.ok(!inputs.some((i) => i.path === "."));
    assert.equal(inputs.find((i) => i.path === ".dockerignore")?.required, false);
  });

  it("treats lockfiles as optional and the named files as required", () => {
    const inputs = keyInputs({ build: { devcontainer: ".devcontainer/devcontainer.json" } });
    assert.equal(inputs.find((i) => i.path === ".devcontainer")?.required, true);
    assert.equal(inputs.find((i) => i.path === "yarn.lock")?.required, false);
  });
});

describe("tags", () => {
  it("builds a docker-safe tag, under the registry when set", () => {
    const key = "a".repeat(64);
    assert.equal(imageTag("My Project!", key), `band-env/my-project:${"a".repeat(16)}`);
    assert.equal(
      imageTag("api", key, "ghcr.io/acme/"),
      `ghcr.io/acme/band-env/api:${"a".repeat(16)}`,
    );
  });
});

describe("command construction", () => {
  it("builds a dockerfile build with the file's directory as context", () => {
    assert.deepEqual(
      dockerBuildArgs({ checkout: "/tmp/src", dockerfile: "docker/Dockerfile", tag: "t:1" }),
      ["build", "--tag", "t:1", "--file", "/tmp/src/docker/Dockerfile", "/tmp/src/docker"],
    );
  });

  it("builds a devcontainer build", () => {
    assert.deepEqual(
      devcontainerBuildArgs({
        checkout: "/tmp/src",
        config: ".devcontainer/devcontainer.json",
        tag: "t:1",
      }),
      [
        "build",
        "--workspace-folder",
        "/tmp/src",
        "--config",
        "/tmp/src/.devcontainer/devcontainer.json",
        "--image-name",
        "t:1",
      ],
    );
  });

  it("refuses a path outside the repository", () => {
    assert.throws(() =>
      dockerBuildArgs({ checkout: "/tmp/src", dockerfile: "../x/Dockerfile", tag: "t" }),
    );
    assert.throws(() =>
      devcontainerBuildArgs({ checkout: "/tmp/src", config: "/etc/x", tag: "t" }),
    );
  });

  it("copies the worker from the worker base in the final layer", () => {
    const text = workerLayerDockerfile({ from: "tc:1", workerBase: "band-worker:latest" });
    assert.match(text, /^FROM tc:1$/m);
    assert.match(text, /COPY --from=band-worker:latest \/opt\/band-worker \/opt\/band\/worker/);
  });

  it("runs install through sh -c and commits with the key as a label", () => {
    const create = installCreateArgs({ name: "c1", image: "img", install: "pnpm install" });
    assert.deepEqual(create.slice(-3), ["img", "-c", "pnpm install"]);
    const commit = commitArgs({ container: "c1", tag: "out:1", key: "k", commit: "abc" });
    assert.deepEqual(commit.slice(-2), ["c1", "out:1"]);
    assert.ok(commit.includes("LABEL band.environment.key=k"));
    assert.ok(commit.includes("LABEL band.environment.commit=abc"));
  });
});

describe("scrubEnv", () => {
  it("blanks credentials and BAND_ variables, keeps the docker connection settings and the rest", () => {
    const out = scrubEnv({
      BAND_ADMIN_TOKEN: "x",
      GITHUB_TOKEN: "y",
      AWS_SECRET_ACCESS_KEY: "z",
      DOCKER_AUTH_CONFIG: "d",
      DOCKER_HOST: "unix:///sock",
      AWS_ACCESS_KEY_ID: "k",
      PATH: "/bin",
      HOME: "/h",
    });
    assert.deepEqual(out, {
      BAND_ADMIN_TOKEN: "",
      GITHUB_TOKEN: "",
      AWS_SECRET_ACCESS_KEY: "",
      DOCKER_AUTH_CONFIG: "",
      AWS_ACCESS_KEY_ID: "",
    });
  });
});
