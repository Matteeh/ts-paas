import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("integration isolation hygiene", () => {
  it("labels the ingress integration test paas.test=ingress only", () => {
    const source = read("./integration/ingress.itest.ts");
    assert.ok(
      source.includes('"paas.test": "ingress"'),
      "ingress.itest.ts does not label its resources paas.test=ingress",
    );
    assert.ok(
      !source.includes('"paas.test": "true"'),
      "ingress.itest.ts still uses the contract suite's paas.test=true label",
    );
  });

  it("labels the contract integration test paas.test=true only", () => {
    const source = read("./integration/docker.itest.ts");
    assert.ok(
      source.includes('"paas.test": "true"'),
      "docker.itest.ts does not label its resources paas.test=true",
    );
    assert.ok(
      !source.includes('"paas.test": "ingress"'),
      "docker.itest.ts uses the ingress test's paas.test=ingress label",
    );
  });
});
