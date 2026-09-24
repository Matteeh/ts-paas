import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeClock } from "../src/clock.js";
import { deploy } from "../src/deployments/engine.js";
import type { DeployOptions } from "../src/deployments/engine.js";
import { DeploymentInProgressError } from "../src/deployments/errors.js";
import type { DeployEvent, EngineDeps } from "../src/deployments/types.js";
import { DEFAULT_HEALTH_WINDOW_MS } from "../src/deployments/types.js";
import { NameConflictError, RuntimeError } from "../src/runtime/errors.js";
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
import { createApp, updateApp } from "../src/state/apps.js";
import { openStore, type Store } from "../src/state/db.js";
import {
  deploymentHistory,
  deploymentStatusChanges,
  getDeployment,
} from "../src/state/deployments.js";
import { AppNotFoundError } from "../src/state/errors.js";

const IMAGE_A = "nginx:1";
const IMAGE_B = "nginx:2";

interface SetupOptions {
  scripts?: Record<string, FakeImageScript>;
  pullFailures?: string[];
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
  const runtime = new FakeRuntime({
    clock,
    scripts: options.scripts,
    pullFailures: options.pullFailures,
  });
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

class SpecCapturingRuntime extends DelegatingRuntime {
  private readonly specs: ContainerSpec[];

  constructor(inner: ContainerRuntime, specs: ContainerSpec[]) {
    super(inner);
    this.specs = specs;
  }

  override async createContainer(spec: ContainerSpec): Promise<string> {
    this.specs.push(spec);
    return this.inner.createContainer(spec);
  }
}

class StartFailingRuntime extends DelegatingRuntime {
  private readonly error: RuntimeError;

  constructor(inner: ContainerRuntime, error: RuntimeError) {
    super(inner);
    this.error = error;
  }

  override startContainer(): Promise<void> {
    return Promise.reject(this.error);
  }
}

class RemoveFailingRuntime extends DelegatingRuntime {
  private readonly target: string;
  private readonly error: RuntimeError;

  constructor(inner: ContainerRuntime, target: string, error: RuntimeError) {
    super(inner);
    this.target = target;
    this.error = error;
  }

  override removeContainer(
    idOrName: string,
    options?: { force?: boolean },
  ): Promise<void> {
    if (idOrName === this.target) {
      return Promise.reject(this.error);
    }
    return this.inner.removeContainer(idOrName, options);
  }
}

describe("deploy engine", () => {
  it("runs a first deployment through pending, pulling, starting and running", async () => {
    const { store, runtime, deps } = setup();
    try {
      createApp(store, {
        name: "web",
        image: IMAGE_A,
        port: 80,
        env: { A: "1" },
      });
      const specs: ContainerSpec[] = [];
      const wrappedDeps: EngineDeps = {
        ...deps,
        runtime: new SpecCapturingRuntime(runtime, specs),
      };

      const result = await runDeploy(wrappedDeps, "web");

      assert.equal(result.status, "running");
      assert.notEqual(result.containerId, null);
      assert.deepEqual(
        deploymentStatusChanges(store, result.id).map((change) => change.status),
        ["pending", "pulling", "starting", "running"],
      );

      assert.equal(specs.length, 1);
      const spec = specs[0]!;
      assert.equal(spec.name, "web-d1");
      assert.deepEqual(spec.labels, {
        "paas.app": "web",
        "paas.deployment": "d1",
      });
      assert.equal(spec.network, "paas-net");
      assert.equal(spec.internalPort, 80);
      assert.deepEqual(spec.env, { A: "1" });
      assert.equal(spec.restartPolicy, "unless-stopped");

      const info = await runtime.inspectContainer(result.containerId!);
      assert.equal(info.state, "running");
      assert.equal(info.labels["paas.managed"], "true");
    } finally {
      store.close();
    }
  });

  it("replaces the previous running deployment only after the new one is running", async () => {
    const { store, runtime, deps, events } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");
      events.length = 0;

      updateApp(store, "web", { image: IMAGE_B });
      const second = await runDeploy(deps, "web");

      assert.equal(second.status, "running");
      const previous = getDeployment(store, first.id);
      assert.equal(previous.status, "replaced");
      assert.notEqual(previous.finishedAt, null);

      assert.deepEqual(
        await runtime.listContainers({ "paas.deployment": first.id }),
        [],
      );

      assert.deepEqual(
        events.map((event) => event.status),
        ["pending", "pulling", "starting", "running", "replaced"],
      );
      for (const event of events) {
        assert.ok(event.message.length > 0);
      }
      assert.equal(events[3]!.deploymentId, second.id);
      assert.equal(events[4]!.deploymentId, first.id);
    } finally {
      store.close();
    }
  });

  it("fails a deployment that exits during the health window and keeps the previous one", async () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`);
    const { store, runtime, deps } = setup({
      scripts: {
        "crash:3": {
          exitCode: 3,
          logs: lines.map((text) => ({ stream: "stdout" as const, text })),
        },
      },
    });
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");

      updateApp(store, "web", { image: "crash:3" });
      const second = await runDeploy(deps, "web");

      assert.equal(second.status, "failed");
      const messageLines = second.error!.split("\n");
      assert.equal(messageLines[0], "container exited with code 3");
      assert.equal(messageLines.length, 21);
      assert.deepEqual(messageLines.slice(1), lines.slice(5));

      assert.deepEqual(
        await runtime.listContainers({ "paas.deployment": second.id }),
        [],
      );

      assert.equal(getDeployment(store, first.id).status, "running");
      const previousInfo = await runtime.inspectContainer(first.containerId!);
      assert.equal(previousInfo.state, "running");
    } finally {
      store.close();
    }
  });

  it("fails the deployment when the pull fails without creating a container", async () => {
    const { store, runtime, deps } = setup({
      pullFailures: ["missing:1"],
    });
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");

      updateApp(store, "web", { image: "missing:1" });
      const second = await runDeploy(deps, "web");

      assert.equal(second.status, "failed");
      assert.equal(second.error, "image not found: missing:1");
      assert.deepEqual(
        await runtime.listContainers({ "paas.deployment": second.id }),
        [],
      );
      assert.equal(getDeployment(store, first.id).status, "running");
    } finally {
      store.close();
    }
  });

  it("fails with the name conflict message when the container name is taken", async () => {
    const { store, runtime, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");

      updateApp(store, "web", { image: IMAGE_B });
      await runtime.pullImage(IMAGE_B);
      await runtime.createContainer({ name: "web-d2", image: IMAGE_B });

      const second = await runDeploy(deps, "web");

      assert.equal(second.status, "failed");
      assert.equal(second.error, "container name already in use: web-d2");
      assert.equal(getDeployment(store, first.id).status, "running");
    } finally {
      store.close();
    }
  });

  it("fails with the runtime message and removes the new container when start fails", async () => {
    const { store, runtime, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");

      updateApp(store, "web", { image: IMAGE_B });
      const failingDeps: EngineDeps = {
        ...deps,
        runtime: new StartFailingRuntime(runtime, new RuntimeError("boom")),
      };
      const second = await runDeploy(failingDeps, "web");

      assert.equal(second.status, "failed");
      assert.equal(second.error, "boom");
      assert.deepEqual(
        await runtime.listContainers({ "paas.deployment": second.id }),
        [],
      );
      assert.equal(getDeployment(store, first.id).status, "running");
    } finally {
      store.close();
    }
  });

  it("refuses a second deploy while one is in progress", async () => {
    const { clock, store, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const firstPromise = deploy(deps, "web");
      await new Promise<void>((resolve) => setImmediate(resolve));

      await assert.rejects(
        deploy(deps, "web"),
        DeploymentInProgressError,
      );
      assert.equal(deploymentHistory(store, "web").length, 1);

      await clock.advance(DEFAULT_HEALTH_WINDOW_MS);
      const first = await firstPromise;
      assert.equal(first.status, "running");
    } finally {
      store.close();
    }
  });

  it("rejects a deploy of an unknown app", async () => {
    const { store, deps } = setup();
    try {
      await assert.rejects(deploy(deps, "nope"), AppNotFoundError);
    } finally {
      store.close();
    }
  });

  it("keeps the new deployment running and reports the error when the previous container cannot be removed", async () => {
    const { store, runtime, deps, events } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");

      updateApp(store, "web", { image: IMAGE_B });
      events.length = 0;

      const failingDeps: EngineDeps = {
        ...deps,
        runtime: new RemoveFailingRuntime(
          runtime,
          first.containerId!,
          new RuntimeError("stuck"),
        ),
      };
      const second = await runDeploy(failingDeps, "web");

      assert.equal(second.status, "running");
      assert.equal(getDeployment(store, first.id).status, "replaced");
      const replaced = events.find((event) => event.status === "replaced");
      assert.ok(replaced);
      assert.ok(replaced!.message.includes("stuck"));
    } finally {
      store.close();
    }
  });

  it("counts a previous container that no longer exists as removed", async () => {
    const { store, runtime, deps, events } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");

      await runtime.removeContainer(first.containerId!, { force: true });
      updateApp(store, "web", { image: IMAGE_B });
      events.length = 0;

      const second = await runDeploy(deps, "web");

      assert.equal(second.status, "running");
      assert.equal(getDeployment(store, first.id).status, "replaced");
      const replaced = events.find((event) => event.status === "replaced");
      assert.ok(replaced);
      assert.ok(!replaced!.message.toLowerCase().includes("could not"));
    } finally {
      store.close();
    }
  });
});
