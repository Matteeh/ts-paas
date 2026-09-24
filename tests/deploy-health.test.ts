import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeClock } from "../src/clock.js";
import {
  AppNotRunningError,
  DeployError,
  DeploymentInProgressError,
} from "../src/deployments/errors.js";
import { checkHealth, healthFailureMessage } from "../src/deployments/health.js";
import {
  APP_LABEL,
  DEFAULT_HEALTH_WINDOW_MS,
  DEFAULT_STOP_TIMEOUT_SECONDS,
  DEPLOYMENT_LABEL,
  HEALTH_LOG_LINES,
  IN_PROGRESS_STATUSES,
  PAAS_NETWORK,
  containerName,
} from "../src/deployments/types.js";
import { RuntimeError, RuntimeUnavailableError } from "../src/runtime/errors.js";
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

const WINDOW_MS = 3000;
const IMAGE = "app:1";

/** Resolve once the pending checkHealth has reached its sleep. */
async function settleOnce(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function runningContainer(
  clock: FakeClock,
): Promise<{ runtime: FakeRuntime; id: string }> {
  const runtime = new FakeRuntime({ clock });
  await runtime.pullImage(IMAGE);
  const id = await runtime.createContainer({ name: "web-1", image: IMAGE });
  await runtime.startContainer(id);
  return { runtime, id };
}

class DelegatingRuntime implements ContainerRuntime {
  protected readonly inner: ContainerRuntime;

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

  inspectContainer(idOrName: string): Promise<ContainerInfo> {
    return this.inner.inspectContainer(idOrName);
  }

  listContainers(
    labels: Record<string, string>,
  ): Promise<ContainerSummary[]> {
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

class RestartCountRuntime extends DelegatingRuntime {
  private readonly restartCount: number;

  constructor(inner: ContainerRuntime, restartCount: number) {
    super(inner);
    this.restartCount = restartCount;
  }

  override async inspectContainer(idOrName: string): Promise<ContainerInfo> {
    const info = await this.inner.inspectContainer(idOrName);
    return { ...info, restartCount: this.restartCount };
  }
}

class FailingInspectRuntime extends DelegatingRuntime {
  private readonly error: RuntimeError;

  constructor(inner: ContainerRuntime, error: RuntimeError) {
    super(inner);
    this.error = error;
  }

  override inspectContainer(): Promise<ContainerInfo> {
    return Promise.reject(this.error);
  }
}

describe("checkHealth", () => {
  it("is healthy only after the full window", async () => {
    const clock = new FakeClock();
    const { runtime, id } = await runningContainer(clock);

    let settled = false;
    const promise = checkHealth(runtime, clock, id, WINDOW_MS).then((result) => {
      settled = true;
      return result;
    });

    await settleOnce();
    await clock.advance(WINDOW_MS - 1);
    assert.equal(settled, false);

    await clock.advance(1);
    assert.deepStrictEqual(await promise, { healthy: true });
  });

  it("is healthy with a zero window without advancing", async () => {
    const clock = new FakeClock();
    const { runtime, id } = await runningContainer(clock);

    assert.deepStrictEqual(await checkHealth(runtime, clock, id, 0), {
      healthy: true,
    });
  });

  it("fails at once when the container has already exited", async () => {
    const clock = new FakeClock();
    const runtime = new FakeRuntime({
      clock,
      scripts: { [IMAGE]: { exitCode: 3 } },
    });
    await runtime.pullImage(IMAGE);
    const id = await runtime.createContainer({ name: "web-1", image: IMAGE });
    await runtime.startContainer(id);

    const result = await checkHealth(runtime, clock, id, WINDOW_MS);
    assert.deepStrictEqual(result, {
      healthy: false,
      reason: "container exited with code 3",
      exitCode: 3,
      logs: [],
    });
  });

  it("fails without a window when the container was never running", async () => {
    const clock = new FakeClock();
    const runtime = new FakeRuntime({ clock });
    await runtime.pullImage(IMAGE);
    const id = await runtime.createContainer({ name: "web-1", image: IMAGE });

    const result = await checkHealth(runtime, clock, id, WINDOW_MS);
    assert.deepStrictEqual(result, {
      healthy: false,
      reason: "container is not running (state created)",
      exitCode: null,
      logs: [],
    });
  });

  it("fails when the container exits inside the window", async () => {
    const clock = new FakeClock();
    const runtime = new FakeRuntime({
      clock,
      scripts: { [IMAGE]: { exitCode: 1, exitAfterMs: 1000 } },
    });
    await runtime.pullImage(IMAGE);
    const id = await runtime.createContainer({ name: "web-1", image: IMAGE });
    await runtime.startContainer(id);

    const promise = checkHealth(runtime, clock, id, WINDOW_MS);
    await settleOnce();
    await clock.advance(WINDOW_MS);

    const result = await promise;
    assert.equal(result.healthy, false);
    if (!result.healthy) {
      assert.equal(result.reason, "container exited with code 1");
      assert.equal(result.exitCode, 1);
    }
  });

  it("fails when the container exits exactly at the window end", async () => {
    const clock = new FakeClock();
    const runtime = new FakeRuntime({
      clock,
      scripts: { [IMAGE]: { exitCode: 1, exitAfterMs: WINDOW_MS } },
    });
    await runtime.pullImage(IMAGE);
    const id = await runtime.createContainer({ name: "web-1", image: IMAGE });
    await runtime.startContainer(id);

    const promise = checkHealth(runtime, clock, id, WINDOW_MS);
    await settleOnce();
    await clock.advance(WINDOW_MS);

    const result = await promise;
    assert.equal(result.healthy, false);
    if (!result.healthy) {
      assert.equal(result.reason, "container exited with code 1");
      assert.equal(result.exitCode, 1);
    }
  });

  it("is healthy when the container exits after the window", async () => {
    const clock = new FakeClock();
    const runtime = new FakeRuntime({
      clock,
      scripts: { [IMAGE]: { exitCode: 1, exitAfterMs: WINDOW_MS + 1 } },
    });
    await runtime.pullImage(IMAGE);
    const id = await runtime.createContainer({ name: "web-1", image: IMAGE });
    await runtime.startContainer(id);

    const promise = checkHealth(runtime, clock, id, WINDOW_MS);
    await settleOnce();
    await clock.advance(WINDOW_MS);

    assert.deepStrictEqual(await promise, { healthy: true });
  });

  it("fails when the container restarted during the window", async () => {
    const clock = new FakeClock();
    const { runtime, id } = await runningContainer(clock);
    const restarted = new RestartCountRuntime(runtime, 1);

    const promise = checkHealth(restarted, clock, id, WINDOW_MS);
    await settleOnce();
    await clock.advance(WINDOW_MS);

    const result = await promise;
    assert.equal(result.healthy, false);
    if (!result.healthy) {
      assert.equal(
        result.reason,
        "container restarted during the health window",
      );
    }
  });

  it("returns the last 20 log texts when unhealthy", async () => {
    const clock = new FakeClock();
    const lines = Array.from({ length: 25 }, (_, index) => ({
      stream: "stdout" as const,
      text: `line-${index + 1}`,
    }));
    const runtime = new FakeRuntime({
      clock,
      scripts: { [IMAGE]: { exitCode: 3, logs: lines } },
    });
    await runtime.pullImage(IMAGE);
    const id = await runtime.createContainer({ name: "web-1", image: IMAGE });
    await runtime.startContainer(id);

    const result = await checkHealth(runtime, clock, id, WINDOW_MS);
    assert.equal(result.healthy, false);
    if (!result.healthy) {
      const expected = Array.from(
        { length: 20 },
        (_, index) => `line-${index + 6}`,
      );
      assert.deepStrictEqual(result.logs, expected);
    }
  });

  it("propagates a runtime error from inspectContainer", async () => {
    const clock = new FakeClock();
    const { runtime, id } = await runningContainer(clock);
    const boom = new RuntimeError("boom");
    const failing = new FailingInspectRuntime(runtime, boom);

    await assert.rejects(
      checkHealth(failing, clock, id, WINDOW_MS),
      (error: unknown) => error === boom,
    );
  });

  it("propagates a RuntimeUnavailableError from inspectContainer", async () => {
    const clock = new FakeClock();
    const runtime = new FakeRuntime({ clock });
    runtime.unavailable = true;

    await assert.rejects(
      checkHealth(runtime, clock, "missing", WINDOW_MS),
      RuntimeUnavailableError,
    );
  });
});

describe("healthFailureMessage", () => {
  it("joins the reason and each log line with newlines", () => {
    assert.equal(
      healthFailureMessage({ reason: "r", logs: ["a", "b"] }),
      "r\na\nb",
    );
  });

  it("is just the reason without logs", () => {
    assert.equal(healthFailureMessage({ reason: "r", logs: [] }), "r");
  });
});

describe("deployments shared surface", () => {
  it("exposes the constants and container name helper", () => {
    assert.equal(PAAS_NETWORK, "paas-net");
    assert.equal(APP_LABEL, "paas.app");
    assert.equal(DEPLOYMENT_LABEL, "paas.deployment");
    assert.equal(DEFAULT_HEALTH_WINDOW_MS, 3000);
    assert.equal(DEFAULT_STOP_TIMEOUT_SECONDS, 10);
    assert.equal(HEALTH_LOG_LINES, 20);
    assert.deepStrictEqual(IN_PROGRESS_STATUSES, [
      "pending",
      "pulling",
      "starting",
    ]);
    assert.equal(containerName("web", "abc123"), "web-abc123");
  });

  it("defines typed deployment errors", () => {
    const inProgress = new DeploymentInProgressError("web", "abc123");
    assert.ok(inProgress instanceof DeployError);
    assert.equal(inProgress.name, "DeploymentInProgressError");
    assert.equal(
      inProgress.message,
      'app "web" already has deployment abc123 in progress',
    );

    const notRunning = new AppNotRunningError("web");
    assert.ok(notRunning instanceof DeployError);
    assert.equal(notRunning.name, "AppNotRunningError");
    assert.equal(notRunning.message, 'app "web" has no running deployment');
  });
});
