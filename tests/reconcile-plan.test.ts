import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeClock } from "../src/clock.js";
import {
  applyReconcile,
  planReconcile,
} from "../src/deployments/reconcile.js";
import type { EngineDeps } from "../src/deployments/types.js";
import { APP_LABEL } from "../src/deployments/types.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import type { FakeImageScript } from "../src/runtime/fake.js";
import { MANAGED_LABEL } from "../src/runtime/types.js";
import type {
  ContainerRuntime,
  ContainerSpec,
} from "../src/runtime/types.js";
import { createApp } from "../src/state/apps.js";
import { openStore, type Store } from "../src/state/db.js";
import {
  createDeployment,
  deploymentStatusChanges,
  getDeployment,
  setDeploymentStatus,
} from "../src/state/deployments.js";

const IMAGE = "nginx:1";

interface Setup {
  clock: FakeClock;
  store: Store;
  runtime: FakeRuntime;
  deps: EngineDeps;
}

function makeSetup(
  runtimeFactory: (clock: FakeClock) => FakeRuntime = (clock) =>
    new FakeRuntime({ clock }),
): Setup {
  const clock = new FakeClock();
  let n = 0;
  const store = openStore(":memory:", { clock, newId: () => `d${++n}` });
  const runtime = runtimeFactory(clock);
  const deps: EngineDeps = { store, runtime, clock };
  return { clock, store, runtime, deps };
}

function setup(scripts: Record<string, FakeImageScript> = {}): Setup {
  return makeSetup((clock) => new FakeRuntime({ clock, scripts }));
}

async function addContainer(
  runtime: FakeRuntime,
  spec: ContainerSpec,
): Promise<string> {
  await runtime.pullImage(spec.image);
  return runtime.createContainer(spec);
}

async function listManaged(runtime: FakeRuntime) {
  return runtime.listContainers({ [MANAGED_LABEL]: "true" });
}

/** Seed an app with one running deployment and one running container. */
async function seedRunning(
  s: Setup,
  app: string,
): Promise<{ deploymentId: string; containerId: string }> {
  createApp(s.store, { name: app, image: IMAGE, port: 80 });
  const deployment = createDeployment(s.store, { app, image: IMAGE });
  const containerId = await addContainer(s.runtime, {
    name: `${app}-${deployment.id}`,
    image: IMAGE,
    labels: { [APP_LABEL]: app, "paas.deployment": deployment.id },
  });
  setDeploymentStatus(s.store, deployment.id, "starting", { containerId });
  await s.runtime.startContainer(containerId);
  setDeploymentStatus(s.store, deployment.id, "running");
  return { deploymentId: deployment.id, containerId };
}

class RemoveFailingRuntime extends FakeRuntime {
  target: string | null = null;

  override async removeContainer(
    idOrName: string,
    options?: { force?: boolean },
  ): Promise<void> {
    if (this.target !== null && idOrName === this.target) {
      throw new RuntimeError("device busy");
    }
    return super.removeContainer(idOrName, options);
  }
}

describe("planReconcile", () => {
  it("reports an empty plan when state and engine agree and changes nothing", async () => {
    const s = setup();
    try {
      const { deploymentId, containerId } = await seedRunning(s, "web");
      const before = await listManaged(s.runtime);

      const plan = await planReconcile(s.deps);

      assert.deepEqual(plan, []);
      assert.equal(getDeployment(s.store, deploymentId).status, "running");
      assert.deepEqual(await listManaged(s.runtime), before);
      assert.equal((await s.runtime.inspectContainer(containerId)).state, "running");
    } finally {
      s.store.close();
    }
  });

  it("fails a running deployment whose container is gone", async () => {
    const s = setup();
    try {
      const { deploymentId, containerId } = await seedRunning(s, "web");
      await s.runtime.removeContainer(containerId, { force: true });

      const plan = await planReconcile(s.deps);

      assert.deepEqual(plan, [
        {
          kind: "fail",
          app: "web",
          deploymentId,
          containerId,
          error: "container disappeared",
        },
      ]);
      assert.equal(getDeployment(s.store, deploymentId).status, "running");
      assert.deepEqual(await listManaged(s.runtime), []);
    } finally {
      s.store.close();
    }
  });

  it("fails a running deployment whose container id is null", async () => {
    const s = setup();
    try {
      createApp(s.store, { name: "web", image: IMAGE, port: 80 });
      const deployment = createDeployment(s.store, { app: "web", image: IMAGE });
      setDeploymentStatus(s.store, deployment.id, "running");

      const plan = await planReconcile(s.deps);

      assert.deepEqual(plan, [
        {
          kind: "fail",
          app: "web",
          deploymentId: deployment.id,
          containerId: null,
          error: "container disappeared",
        },
      ]);
      assert.equal(getDeployment(s.store, deployment.id).status, "running");
    } finally {
      s.store.close();
    }
  });

  it("fails a running deployment whose container exited and reports its container", async () => {
    const s = setup({ [IMAGE]: { exitCode: 137, exitAfterMs: 1000 } });
    try {
      createApp(s.store, { name: "web", image: IMAGE, port: 80 });
      const deployment = createDeployment(s.store, { app: "web", image: IMAGE });
      const containerId = await addContainer(s.runtime, {
        name: `web-${deployment.id}`,
        image: IMAGE,
        labels: { [APP_LABEL]: "web", "paas.deployment": deployment.id },
      });
      setDeploymentStatus(s.store, deployment.id, "starting", { containerId });
      await s.runtime.startContainer(containerId);
      setDeploymentStatus(s.store, deployment.id, "running");
      await s.clock.advance(1000);

      const plan = await planReconcile(s.deps);

      assert.deepEqual(plan, [
        {
          kind: "fail",
          app: "web",
          deploymentId: deployment.id,
          containerId,
          error: "container exited with code 137",
        },
        {
          kind: "orphan",
          app: "web",
          containerId,
          name: `web-${deployment.id}`,
        },
      ]);
    } finally {
      s.store.close();
    }
  });

  it("fails a running deployment whose container was created but never started", async () => {
    const s = setup();
    try {
      createApp(s.store, { name: "web", image: IMAGE, port: 80 });
      const deployment = createDeployment(s.store, { app: "web", image: IMAGE });
      const containerId = await addContainer(s.runtime, {
        name: `web-${deployment.id}`,
        image: IMAGE,
        labels: { [APP_LABEL]: "web", "paas.deployment": deployment.id },
      });
      setDeploymentStatus(s.store, deployment.id, "starting", { containerId });
      setDeploymentStatus(s.store, deployment.id, "running");

      const plan = await planReconcile(s.deps);

      assert.deepEqual(plan, [
        {
          kind: "fail",
          app: "web",
          deploymentId: deployment.id,
          containerId,
          error: "container is not running",
        },
        {
          kind: "orphan",
          app: "web",
          containerId,
          name: `web-${deployment.id}`,
        },
      ]);
    } finally {
      s.store.close();
    }
  });

  it("fails a deployment stuck in pulling past the threshold", async () => {
    const s = setup();
    try {
      createApp(s.store, { name: "web", image: IMAGE, port: 80 });
      const deployment = createDeployment(s.store, { app: "web", image: IMAGE });
      setDeploymentStatus(s.store, deployment.id, "pulling");
      const at = deploymentStatusChanges(s.store, deployment.id).at(-1)!.at;

      await s.clock.advance(600_001);
      const plan = await planReconcile(s.deps);

      assert.deepEqual(plan, [
        {
          kind: "fail",
          app: "web",
          deploymentId: deployment.id,
          containerId: null,
          error: `stuck in pulling since ${at}`,
        },
      ]);
      assert.equal(getDeployment(s.store, deployment.id).status, "pulling");
    } finally {
      s.store.close();
    }
  });

  it("does not fail a deployment exactly at the threshold", async () => {
    const s = setup();
    try {
      createApp(s.store, { name: "web", image: IMAGE, port: 80 });
      const deployment = createDeployment(s.store, { app: "web", image: IMAGE });
      setDeploymentStatus(s.store, deployment.id, "pulling");

      await s.clock.advance(600_000);
      const plan = await planReconcile(s.deps);

      assert.deepEqual(plan, []);
    } finally {
      s.store.close();
    }
  });

  it("honors a custom stuck threshold", async () => {
    const s = setup();
    try {
      createApp(s.store, { name: "web", image: IMAGE, port: 80 });
      const deployment = createDeployment(s.store, { app: "web", image: IMAGE });
      setDeploymentStatus(s.store, deployment.id, "pulling");

      await s.clock.advance(59_000);
      const plan = await planReconcile(s.deps, { stuckAfterMs: 60_000 });

      assert.deepEqual(plan, []);
    } finally {
      s.store.close();
    }
  });

  it("reports a replaced deployment's leftover container as an orphan", async () => {
    const s = setup();
    try {
      createApp(s.store, { name: "web", image: IMAGE, port: 80 });

      const first = createDeployment(s.store, { app: "web", image: IMAGE });
      const firstContainer = await addContainer(s.runtime, {
        name: `web-${first.id}`,
        image: IMAGE,
        labels: { [APP_LABEL]: "web", "paas.deployment": first.id },
      });
      setDeploymentStatus(s.store, first.id, "starting", {
        containerId: firstContainer,
      });
      await s.runtime.startContainer(firstContainer);
      setDeploymentStatus(s.store, first.id, "running");

      const second = createDeployment(s.store, { app: "web", image: IMAGE });
      const secondContainer = await addContainer(s.runtime, {
        name: `web-${second.id}`,
        image: IMAGE,
        labels: { [APP_LABEL]: "web", "paas.deployment": second.id },
      });
      setDeploymentStatus(s.store, second.id, "starting", {
        containerId: secondContainer,
      });
      await s.runtime.startContainer(secondContainer);
      setDeploymentStatus(s.store, second.id, "running");

      setDeploymentStatus(s.store, first.id, "replaced");

      const plan = await planReconcile(s.deps);

      assert.deepEqual(plan, [
        {
          kind: "orphan",
          app: "web",
          containerId: firstContainer,
          name: `web-${first.id}`,
        },
      ]);
    } finally {
      s.store.close();
    }
  });

  it("does not report the container of a deployment still in flight", async () => {
    const s = setup();
    try {
      createApp(s.store, { name: "web", image: IMAGE, port: 80 });
      const deployment = createDeployment(s.store, { app: "web", image: IMAGE });
      const containerId = await addContainer(s.runtime, {
        name: `web-${deployment.id}`,
        image: IMAGE,
        labels: { [APP_LABEL]: "web", "paas.deployment": deployment.id },
      });
      setDeploymentStatus(s.store, deployment.id, "starting", { containerId });
      await s.runtime.startContainer(containerId);

      await s.clock.advance(60_000);
      const plan = await planReconcile(s.deps);

      assert.deepEqual(plan, []);
    } finally {
      s.store.close();
    }
  });

  it("never reports a container without an app label", async () => {
    const s = setup();
    try {
      await addContainer(s.runtime, {
        name: "paas-caddy",
        image: IMAGE,
        labels: { "paas.ingress": "caddy" },
      });

      const plan = await planReconcile(s.deps);

      assert.deepEqual(plan, []);
    } finally {
      s.store.close();
    }
  });

  it("orders failures by app name and orphans by container name", async () => {
    const s = setup();
    try {
      const zebra = await seedRunning(s, "zebra");
      await s.runtime.removeContainer(zebra.containerId, { force: true });
      const alpha = await seedRunning(s, "alpha");
      await s.runtime.removeContainer(alpha.containerId, { force: true });

      await addContainer(s.runtime, {
        name: "m-old",
        image: IMAGE,
        labels: { [APP_LABEL]: "web" },
      });
      await addContainer(s.runtime, {
        name: "b-old",
        image: IMAGE,
        labels: { [APP_LABEL]: "web" },
      });

      const plan = await planReconcile(s.deps);

      assert.deepEqual(
        plan.map((item) => item.kind),
        ["fail", "fail", "orphan", "orphan"],
      );
      assert.deepEqual(
        plan.slice(0, 2).map((item) => (item.kind === "fail" ? item.app : "")),
        ["alpha", "zebra"],
      );
      assert.deepEqual(
        plan
          .slice(2)
          .map((item) => (item.kind === "orphan" ? item.name : "")),
        ["b-old", "m-old"],
      );
    } finally {
      s.store.close();
    }
  });
});

describe("applyReconcile", () => {
  it("marks failures failed and reports orphans without prune", async () => {
    const s = setup();
    try {
      const { deploymentId, containerId } = await seedRunning(s, "web");
      const orphanId = await addContainer(s.runtime, {
        name: "web-old",
        image: IMAGE,
        labels: { [APP_LABEL]: "web" },
      });
      await s.runtime.startContainer(orphanId);
      await s.runtime.removeContainer(containerId, { force: true });

      const plan = await planReconcile(s.deps);
      const outcomes = await applyReconcile(s.deps, plan, { prune: false });

      assert.equal(outcomes.length, 2);
      assert.deepEqual(
        outcomes.map((outcome) => outcome.result),
        ["done", "reported"],
      );
      assert.equal(outcomes[0]!.error, null);

      const failed = getDeployment(s.store, deploymentId);
      assert.equal(failed.status, "failed");
      assert.equal(failed.error, "container disappeared");
      assert.equal((await s.runtime.inspectContainer(orphanId)).state, "running");
    } finally {
      s.store.close();
    }
  });

  it("force-removes orphans with prune and counts missing ones as removed", async () => {
    const s = setup();
    try {
      const goneId = await addContainer(s.runtime, {
        name: "a-old",
        image: IMAGE,
        labels: { [APP_LABEL]: "web" },
      });
      const presentId = await addContainer(s.runtime, {
        name: "b-old",
        image: IMAGE,
        labels: { [APP_LABEL]: "web" },
      });
      const plan = await planReconcile(s.deps);
      await s.runtime.removeContainer(goneId, { force: true });
      const outcomes = await applyReconcile(s.deps, plan, { prune: true });

      assert.deepEqual(
        outcomes.map((outcome) => outcome.result),
        ["done", "done"],
      );
      assert.deepEqual(await listManaged(s.runtime), []);
      await assert.rejects(() => s.runtime.inspectContainer(presentId));
    } finally {
      s.store.close();
    }
  });

  it("continues after a removal fails", async () => {
    const s = makeSetup((clock) => new RemoveFailingRuntime({ clock }));
    try {
      const firstId = await addContainer(s.runtime, {
        name: "a-old",
        image: IMAGE,
        labels: { [APP_LABEL]: "web" },
      });
      const secondId = await addContainer(s.runtime, {
        name: "b-old",
        image: IMAGE,
        labels: { [APP_LABEL]: "web" },
      });
      await s.runtime.startContainer(firstId);
      await s.runtime.startContainer(secondId);
      (s.runtime as RemoveFailingRuntime).target = firstId;

      const plan = await planReconcile(s.deps);
      const outcomes = await applyReconcile(s.deps, plan, { prune: true });

      assert.equal(outcomes[0]!.result, "failed");
      assert.equal(outcomes[0]!.error, "device busy");
      assert.equal(outcomes[1]!.result, "done");
      assert.equal((await s.runtime.inspectContainer(firstId)).state, "running");
      await assert.rejects(() => s.runtime.inspectContainer(secondId));
    } finally {
      s.store.close();
    }
  });
});
