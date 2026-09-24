import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeClock } from "../src/clock.js";
import { deploy } from "../src/deployments/engine.js";
import type { DeployOptions } from "../src/deployments/engine.js";
import type { DeployEvent, EngineDeps } from "../src/deployments/types.js";
import { DEFAULT_HEALTH_WINDOW_MS } from "../src/deployments/types.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import type { FakeImageScript } from "../src/runtime/fake.js";
import { createApp, updateApp } from "../src/state/apps.js";
import { openStore, type Store } from "../src/state/db.js";
import type {
  Deployment,
  DeploymentStatus,
} from "../src/state/deployments.js";
import {
  deploymentStatusChanges,
  getDeployment,
} from "../src/state/deployments.js";

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
  // A rejected hook is expected in several tests; mark the rejection handled
  // so it is only ever observed where it is awaited.
  promise.catch(() => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  await (deps.clock as FakeClock).advance(
    options.healthWindowMs ?? DEFAULT_HEALTH_WINDOW_MS,
  );
  return promise;
}

function changeStatuses(store: Store, id: string): DeploymentStatus[] {
  return deploymentStatusChanges(store, id).map((change) => change.status);
}

describe("deploy onRunning hook", () => {
  it("runs once with the running record before replacing the previous deployment", async () => {
    const { store, runtime, deps, events } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");
      events.length = 0;

      updateApp(store, "web", { image: IMAGE_B });

      const calls: Deployment[] = [];
      let firstStatusAtHook: DeploymentStatus | undefined;
      let firstContainerAtHook: string | undefined;
      const second = await runDeploy(deps, "web", {
        onRunning: async (deployment) => {
          calls.push(deployment);
          firstStatusAtHook = getDeployment(store, first.id).status;
          firstContainerAtHook = (
            await runtime.inspectContainer(first.containerId!)
          ).state;
        },
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.id, second.id);
      assert.equal(calls[0]!.status, "running");
      assert.equal(firstStatusAtHook, "running");
      assert.equal(firstContainerAtHook, "running");

      assert.equal(second.status, "running");
      assert.equal(getDeployment(store, first.id).status, "replaced");
      assert.notEqual(getDeployment(store, first.id).finishedAt, null);
      assert.deepEqual(
        await runtime.listContainers({ "paas.deployment": first.id }),
        [],
      );

      assert.deepEqual(
        events.map((event) => event.status),
        ["pending", "pulling", "starting", "running", "replaced"],
      );
      assert.equal(events[3]!.deploymentId, second.id);
      assert.equal(events[4]!.deploymentId, first.id);
    } finally {
      store.close();
    }
  });

  it("rejects with the hook error and keeps both deployments running", async () => {
    const { store, runtime, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");

      updateApp(store, "web", { image: IMAGE_B });

      const pushError = new Error("push failed");
      const calls: Deployment[] = [];
      const secondPromise = runDeploy(deps, "web", {
        onRunning: async (deployment) => {
          calls.push(deployment);
          throw pushError;
        },
      });

      await assert.rejects(
        secondPromise,
        (error: unknown): boolean => error === pushError,
      );

      assert.equal(calls.length, 1);
      const second = getDeployment(store, calls[0]!.id);
      assert.equal(second.status, "running");
      assert.equal(getDeployment(store, first.id).status, "running");

      assert.equal(
        (await runtime.inspectContainer(second.containerId!)).state,
        "running",
      );
      assert.equal(
        (await runtime.inspectContainer(first.containerId!)).state,
        "running",
      );

      assert.deepEqual(changeStatuses(store, second.id), [
        "pending",
        "pulling",
        "starting",
        "running",
      ]);
      assert.deepEqual(changeStatuses(store, first.id), [
        "pending",
        "pulling",
        "starting",
        "running",
      ]);
    } finally {
      store.close();
    }
  });

  it("calls the hook on a first deploy and behaves as before without one", async () => {
    const { store, deps } = setup();
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });

      const calls: Deployment[] = [];
      const first = await runDeploy(deps, "web", {
        onRunning: async (deployment) => {
          calls.push(deployment);
        },
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.id, first.id);
      assert.equal(calls[0]!.status, "running");
      assert.equal(first.status, "running");

      updateApp(store, "web", { image: IMAGE_B });
      const second = await runDeploy(deps, "web");
      assert.equal(second.status, "running");
      assert.equal(getDeployment(store, first.id).status, "replaced");
    } finally {
      store.close();
    }
  });

  it("never calls the hook when the health window fails", async () => {
    const { store, deps } = setup({
      scripts: { "crash:3": { exitCode: 3 } },
    });
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");

      updateApp(store, "web", { image: "crash:3" });
      let calls = 0;
      const second = await runDeploy(deps, "web", {
        onRunning: async () => {
          calls += 1;
        },
      });

      assert.equal(calls, 0);
      assert.equal(second.status, "failed");
      assert.equal(getDeployment(store, first.id).status, "running");
    } finally {
      store.close();
    }
  });

  it("never calls the hook when the pull fails", async () => {
    const { store, deps } = setup({ pullFailures: ["missing:1"] });
    try {
      createApp(store, { name: "web", image: IMAGE_A, port: 80 });
      const first = await runDeploy(deps, "web");

      updateApp(store, "web", { image: "missing:1" });
      let calls = 0;
      const second = await runDeploy(deps, "web", {
        onRunning: async () => {
          calls += 1;
        },
      });

      assert.equal(calls, 0);
      assert.equal(second.status, "failed");
      assert.equal(getDeployment(store, first.id).status, "running");
    } finally {
      store.close();
    }
  });
});
