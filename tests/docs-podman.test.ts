import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const manual = read("../docs/manual-testing.md");
const readme = read("../README.md");

describe("manual-testing Podman guidance", () => {
  it("steers around podman restart and uses kill instead", () => {
    assert.ok(
      !manual.includes("podman restart"),
      "docs/manual-testing.md still steers with `podman restart`",
    );
    assert.ok(manual.includes("docker restart paas-caddy"));
    assert.ok(manual.includes("podman kill --signal KILL paas-caddy"));
    assert.ok(manual.includes("start-ingress: paas-caddy (started, 1 routes)"));
  });

  it("documents leaked port forwarders before recording results", () => {
    const heading = "## Podman 3.4 port forwarders";
    const index = manual.indexOf(heading);
    const recording = manual.indexOf("## Recording results");
    assert.ok(index >= 0, "missing `## Podman 3.4 port forwarders` section");
    assert.ok(recording > index, "port forwarders section must precede Recording results");
    const section = manual.slice(index, recording);
    assert.ok(section.includes("ss -ltnp"));
    assert.ok(section.includes("containers-rootlessport"));
    assert.ok(section.includes("kill <pid>"));
  });
});

describe("README rootless Podman guidance", () => {
  it("points at reconcile and the port forwarder section", () => {
    const start = readme.indexOf("### Rootless Podman on Linux");
    const end = readme.indexOf("## Development");
    assert.ok(start >= 0 && end > start);
    const rootless = readme.slice(start, end);
    assert.ok(rootless.includes("paas reconcile"));
    assert.ok(rootless.includes("crashed Caddy"));
    assert.ok(rootless.includes("docs/manual-testing.md#podman-34-port-forwarders"));
  });
});
