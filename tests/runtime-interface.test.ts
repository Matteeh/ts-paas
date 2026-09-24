import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RuntimeUnavailableError } from "../src/runtime/errors.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import type {
  ContainerInfo,
  ContainerRuntime,
  ContainerSpec,
  ContainerSummary,
  EngineInfo,
  LogEntry,
  LogOptions,
} from "../src/runtime/types.js";
import { runtimeContract } from "./support/runtime-contract.js";

class ExtraLabelRuntime implements ContainerRuntime {
  private readonly inner: ContainerRuntime;

  constructor(inner: ContainerRuntime) {
    this.inner = inner;
  }

  ping(): Promise<EngineInfo> {
    return this.inner.ping();
  }

  pullImage(ref: string): Promise<void> {
    return this.inner.pullImage(ref);
  }

  createContainer(spec: ContainerSpec): Promise<string> {
    return this.inner.createContainer(spec);
  }

  startContainer(idOrName: string): Promise<void> {
    return this.inner.startContainer(idOrName);
  }

  stopContainer(
    idOrName: string,
    options?: { timeoutSeconds?: number },
  ): Promise<void> {
    return this.inner.stopContainer(idOrName, options);
  }

  removeContainer(
    idOrName: string,
    options?: { force?: boolean },
  ): Promise<void> {
    return this.inner.removeContainer(idOrName, options);
  }

  async inspectContainer(idOrName: string): Promise<ContainerInfo> {
    const info = await this.inner.inspectContainer(idOrName);
    return { ...info, labels: { ...info.labels, extra: "1" } };
  }

  listContainers(labels: Record<string, string>): Promise<ContainerSummary[]> {
    return this.inner.listContainers(labels);
  }

  containerLogs(
    idOrName: string,
    options?: LogOptions,
  ): Promise<LogEntry[]> {
    return this.inner.containerLogs(idOrName, options);
  }

  ensureNetwork(name: string): Promise<void> {
    return this.inner.ensureNetwork(name);
  }

  networkExists(name: string): Promise<boolean> {
    return this.inner.networkExists(name);
  }

  ensureVolume(name: string): Promise<void> {
    return this.inner.ensureVolume(name);
  }
}

// Second contract suite: a wrapped fake whose `inspectContainer` adds a label
// the suite did not ask for, and a pre-existing container carrying the old
// shared filters `x` and `y`. The suite must still pass, proving it tolerates
// extra labels and filters only on keys unique to its run.
runtimeContract("fake with extra labels", async () => {
  const images = {
    present: "contract-present:1",
    missing: "contract-missing:1",
  };
  const inner = new FakeRuntime({ pullFailures: [images.missing] });
  await inner.pullImage(images.present);
  await inner.createContainer({
    name: "contract-preexisting-x-y",
    image: images.present,
    labels: { x: "1", y: "1" },
  });
  return { runtime: new ExtraLabelRuntime(inner), images };
});

describe("FakeRuntime engine details and network existence", () => {
  it("reports an unknown network as absent and a created network as present", async () => {
    const runtime = new FakeRuntime();
    assert.equal(await runtime.networkExists("n1"), false);
    await runtime.ensureNetwork("n1");
    assert.equal(await runtime.networkExists("n1"), true);
  });

  it("rejects networkExists with RuntimeUnavailableError when unavailable", async () => {
    const runtime = new FakeRuntime();
    await runtime.ensureNetwork("n1");
    runtime.unavailable = true;
    await assert.rejects(runtime.networkExists("n1"), RuntimeUnavailableError);
  });

  it("pings with exactly the fake name and version", async () => {
    const runtime = new FakeRuntime();
    assert.deepStrictEqual(await runtime.ping(), {
      name: "fake",
      version: "0.0.0",
    });
  });
});
