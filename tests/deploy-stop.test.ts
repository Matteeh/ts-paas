import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeClock } from "../src/clock.js";
import { deploy } from "../src/deployments/engine.js";
import type { DeployOptions } from "../src/deployments/engine.js";
import { AppNotRunningError } from "../src/deployments/errors.js";
import { stopApp } from "../src/deployments/stop.js";
import type { DeployEvent, EngineDeps } from "../src/deployments/types.js";
import { DEFAULT_HEALTH_WINDOW_MS } from "../src/deployments/types.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import type { FakeImageScript } from "../src/runtime/fake.js";
import type {
  ContainerInfo,
  ContainerRuntime,
  ContainerSpec,
  ContainerSummary,
  EngineInfo,
  LogEntry,
  LogOptions,
} from "../src/runtime/types.js";
import { createApp } from "../src/state/apps.js";
import { openStore, type Store } from "../src/state/db.js";
import { getDeployment } from "../src/state/deployments.js";
import { AppNotFoundError } from "../src/state/errors.js";

const IMAGE_A = "nginx:1";
const IMAGE_B = "nginx:2";

interface SetupOptions {
  scripts?: Record<string, FakeImageScript>;
}

interface Setup {
  clock: FakeClock;
  store: Store;
  runtime: FakeRuntime;
  deps: EngineDeps;
  events: DeployEvent[];
}

function setup(options: SetupOptions = {}): Setup {
  const clock = new FakeClock();
  let n = 0;
  const store = openStore(":memory:", { clock, newId: () => `d${++n}` });
  const runtime = new FakeRuntime({ clock, scripts: options.scripts });
  const events: DeployEvent[] = [];
  const deps: EngineDeps = {
    store,
    runtime,
    clock,
    onProgress: (event) => {
      events.push(event);
    },
  };
  return { clock, store, runtime, deps, events };
}

/** Start a deploy, let it reach its health window, then advance the clock. */
async function runDeploy(
  deps: EngineDeps,
  app: string,
  options: DeployOptions = {},
): Promise<Awaited<ReturnType<typeof deploy>>> {
  const promise = deploy(deps, app, options);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await (deps.clock as FakeClock).advance(
    options.healthWindowMs ?? DEFAULT_HEALTH_WINDOW_MS,
  );
  return promise;
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

class StopFailingRuntime extends DelegatingRuntime {
  private readonly target: string;
  private readonly error: RuntimeError;

  constructor(inner: ContainerRuntime, target: string, error: RuntimeError) {
    super(inner);
    this.target = target;
    this.error = error;
  }

  override stopContainer(
    idOrName: string,
    options?: { timeoutSeconds?: number },
  ): Promise<void> {
    if (idOrName === this.target) {
      return Promise.reject(this.error);
    }
    return this.inner.stopContainer(idOrName, options);
  }
}

class StopCapturingRuntime extends DelegatingRuntime {
  readonly timeouts: (number | undefined)[] = [];

  override stopContainer(
    idOrName: string,
    options?: { timeoutSeconds?: number },
  ): Promise<void> {
    this.timeouts.push(options?.timeoutSeconds);
    return this.inner.stopContainer(idOrName, options);
  }
}

describe("stop app", () => {
  it("stops and removes the running container and marks the deployment stopped", async () => {
    const { store, runtime, deps, events } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const running = await runDeploy(deps, "web");
      assert.equal(running.status, "running");
      events.length = 0;

      const stopped = await stopApp(deps, "web");

      assert.equal(stopped.status, "stopped");
      assert.notEqual(stopped.finishedAt, null);
      assert.deepEqual(
        await runtime.listContainers({ "paas.deployment": running.id }),
        [],
      );

      const stoppedEvents = events.filter(
        (event) => event.status === "stopped",
      );
      assert.equal(stoppedEvents.length, 1);
      assert.equal(stoppedEvents[0]!.deploymentId, running.id);
      assert.ok(stoppedEvents[0]!.message.length > 0);
    } finally {
      store.close();
    }
  });

  it("passes the default and explicit stop timeout to the runtime", async () => {
    const { store, runtime, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      await runDeploy(deps, "web");

      const capturing = new StopCapturingRuntime(runtime);
      await stopApp({ ...deps, runtime: capturing }, "web");
      assert.deepEqual(capturing.timeouts, [10]);

      createApp(store, { name: "api", image: IMAGE_B, port: 80 });
      await runDeploy(deps, "api");
      const capturing2 = new StopCapturingRuntime(runtime);
      await stopApp(
        { ...deps, runtime: capturing2 },
        "api",
        { stopTimeoutSeconds: 3 },
      );
      assert.deepEqual(capturing2.timeouts, [3]);
    } finally {
      store.close();
    }
  });

  it("rejects with AppNotRunningError when there is no running deployment", async () => {
    const { store, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      await assert.rejects(stopApp(deps, "web"), AppNotRunningError);
    } finally {
      store.close();
    }
  });

  it("rejects with AppNotRunningError when the only deployment failed", async () => {
    const { store, deps } = setup({
      scripts: { "crash:3": { exitCode: 3 } },
    });
    try {
      createApp(store, { name: "web", image: "crash:3", port: 80 });
      const failed = await runDeploy(deps, "web");
      assert.equal(failed.status, "failed");

      await assert.rejects(stopApp(deps, "web"), AppNotRunningError);
    } finally {
      store.close();
    }
  });

  it("rejects with AppNotRunningError when the deployment is already stopped", async () => {
    const { store, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      await runDeploy(deps, "web");
      await stopApp(deps, "web");

      await assert.rejects(stopApp(deps, "web"), AppNotRunningError);
    } finally {
      store.close();
    }
  });

  it("rejects with AppNotFoundError for an unknown app", async () => {
    const { store, deps } = setup();
    try {
      await assert.rejects(stopApp(deps, "nope"), AppNotFoundError);
    } finally {
      store.close();
    }
  });

  it("resolves stopped when the container was removed out of band", async () => {
    const { store, runtime, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const running = await runDeploy(deps, "web");

      await runtime.removeContainer(running.containerId!, { force: true });

      const stopped = await stopApp(deps, "web");
      assert.equal(stopped.status, "stopped");
      assert.notEqual(stopped.finishedAt, null);
    } finally {
      store.close();
    }
  });

  it("propagates a stop failure and leaves the deployment running", async () => {
    const { store, runtime, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const running = await runDeploy(deps, "web");

      const failing = new StopFailingRuntime(
        runtime,
        running.containerId!,
        new RuntimeError("busy"),
      );

      await assert.rejects(
        stopApp({ ...deps, runtime: failing }, "web"),
        /busy/,
      );

      assert.equal(getDeployment(store, running.id).status, "running");
      const info = await runtime.inspectContainer(running.containerId!);
      assert.equal(info.state, "running");
    } finally {
      store.close();
    }
  });

  it("leaves the stopped deployment stopped when the app is deployed again", async () => {
    const { store, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");
      await stopApp(deps, "web");

      const second = await runDeploy(deps, "web");

      assert.equal(second.status, "running");
      assert.notEqual(second.id, first.id);
      assert.equal(getDeployment(store, first.id).status, "stopped");
    } finally {
      store.close();
    }
  });
});
