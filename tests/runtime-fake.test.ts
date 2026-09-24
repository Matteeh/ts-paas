import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeClock } from "../src/clock.js";
import { RuntimeUnavailableError } from "../src/runtime/errors.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { MANAGED_LABEL } from "../src/runtime/types.js";
import { runtimeContract } from "./support/runtime-contract.js";

runtimeContract("fake", async () => {
  const images = { present: "contract-present:1", missing: "contract-missing:1" };
  const runtime = new FakeRuntime({ pullFailures: [images.missing] });
  return { runtime, images };
});

describe("FakeRuntime", () => {
  it("reports the fake engine name and version", async () => {
    const runtime = new FakeRuntime();
    assert.deepStrictEqual(await runtime.ping(), {
      name: "fake",
      version: "0.0.0",
    });
  });

  it("assigns container ids in creation order", async () => {
    const runtime = new FakeRuntime();
    await runtime.pullImage("present:1");
    const first = await runtime.createContainer({
      name: "first",
      image: "present:1",
    });
    const second = await runtime.createContainer({
      name: "second",
      image: "present:1",
    });
    assert.equal(first, "fake-1");
    assert.equal(second, "fake-2");
  });

  it("adds the managed label to every created container", async () => {
    const runtime = new FakeRuntime();
    await runtime.pullImage("present:1");
    const id = await runtime.createContainer({
      name: "managed",
      image: "present:1",
      labels: { "paas.app": "web" },
    });
    const info = await runtime.inspectContainer(id);
    assert.deepStrictEqual(info.labels, {
      "paas.app": "web",
      [MANAGED_LABEL]: "true",
    });
  });

  it("exits immediately with the scripted code", async () => {
    const runtime = new FakeRuntime({
      scripts: { "crash:1": { exitCode: 3 } },
    });
    await runtime.pullImage("crash:1");
    const id = await runtime.createContainer({
      name: "crash",
      image: "crash:1",
    });
    await runtime.startContainer(id);
    const info = await runtime.inspectContainer(id);
    assert.equal(info.state, "exited");
    assert.equal(info.exitCode, 3);
  });

  it("exits after the scripted delay once the clock advances", async () => {
    const clock = new FakeClock();
    const runtime = new FakeRuntime({
      clock,
      scripts: { "slow:1": { exitCode: 1, exitAfterMs: 2000 } },
    });
    await runtime.pullImage("slow:1");
    const id = await runtime.createContainer({ name: "slow", image: "slow:1" });
    await runtime.startContainer(id);

    await clock.advance(1999);
    assert.equal((await runtime.inspectContainer(id)).state, "running");

    await clock.advance(1);
    const info = await runtime.inspectContainer(id);
    assert.equal(info.state, "exited");
    assert.equal(info.exitCode, 1);
    assert.equal(info.finishedAt?.getTime(), clock.now().getTime());
  });

  it("honors since and tail over scripted logs from three starts", async () => {
    const clock = new FakeClock();
    const runtime = new FakeRuntime({
      clock,
      scripts: {
        "chatty:1": { logs: [{ stream: "stdout", text: "hello" }] },
      },
    });
    await runtime.pullImage("chatty:1");
    const id = await runtime.createContainer({
      name: "chatty",
      image: "chatty:1",
    });

    await runtime.startContainer(id);
    await runtime.stopContainer(id);
    await clock.advance(1000);
    const second = clock.now();
    await runtime.startContainer(id);
    await runtime.stopContainer(id);
    await clock.advance(1000);
    const third = clock.now();
    await runtime.startContainer(id);
    await runtime.stopContainer(id);

    const logs = await runtime.containerLogs(id);
    assert.equal(logs.length, 3);

    const filtered = await runtime.containerLogs(id, {
      since: second,
      tail: 1,
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.time.getTime(), third.getTime());
  });

  it("rejects every operation with RuntimeUnavailableError when unavailable", async () => {
    const runtime = new FakeRuntime();
    await runtime.pullImage("present:1");
    const id = await runtime.createContainer({
      name: "offline",
      image: "present:1",
    });
    runtime.unavailable = true;

    await assert.rejects(runtime.ping(), RuntimeUnavailableError);
    await assert.rejects(runtime.pullImage("present:1"), RuntimeUnavailableError);
    await assert.rejects(
      runtime.createContainer({ name: "other", image: "present:1" }),
      RuntimeUnavailableError,
    );
    await assert.rejects(runtime.startContainer(id), RuntimeUnavailableError);
    await assert.rejects(runtime.stopContainer(id), RuntimeUnavailableError);
    await assert.rejects(runtime.removeContainer(id), RuntimeUnavailableError);
    await assert.rejects(runtime.inspectContainer(id), RuntimeUnavailableError);
    await assert.rejects(runtime.listContainers({}), RuntimeUnavailableError);
    await assert.rejects(runtime.containerLogs(id), RuntimeUnavailableError);
    await assert.rejects(runtime.ensureNetwork("net"), RuntimeUnavailableError);
    await assert.rejects(runtime.ensureVolume("vol"), RuntimeUnavailableError);
  });
});
