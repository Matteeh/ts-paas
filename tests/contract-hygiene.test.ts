import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { engineLabel } from "./support/runtime-contract.js";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("contract suite hygiene", () => {
  it("does not extend Object globally", () => {
    const source = read("./support/runtime-contract.ts");
    assert.ok(!source.includes("declare global"));
    assert.ok(!source.includes("interface Object"));
  });

  it("has every deploy test double delegate networkExists", () => {
    for (const file of [
      "./deploy-engine.test.ts",
      "./deploy-health.test.ts",
      "./deploy-stop.test.ts",
    ]) {
      assert.ok(
        read(file).includes("networkExists("),
        `${file} does not delegate networkExists`,
      );
    }
  });

  it("labels the integration suite with the engine the socket finds", () => {
    const source = read("./integration/docker.itest.ts");
    assert.match(source, /await runtime\.ping\(\)/);
    assert.match(source, /engineLabel\(/);
  });
});

describe("engineLabel", () => {
  it("names the engine and its endpoint", () => {
    assert.equal(
      engineLabel({
        name: "podman",
        version: "3.4.4",
        endpoint: "/run/user/1000/podman/podman.sock",
      }),
      "podman (/run/user/1000/podman/podman.sock)",
    );
  });

  it("falls back when the engine reports no endpoint", () => {
    assert.equal(engineLabel({ name: "fake", version: "0.0.0" }), "fake (unknown endpoint)");
  });
});
