import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../src/clock.js";
import { createApp, deleteApp, getApp } from "../src/state/apps.js";
import { openStore, type Store } from "../src/state/db.js";
import {
  DEPLOYMENT_STATUSES,
  FINAL_STATUSES,
  createDeployment,
  deploymentHistory,
  deploymentStatusChanges,
  getDeployment,
  latestDeployment,
  setDeploymentStatus,
} from "../src/state/deployments.js";
import {
  AppNotFoundError,
  AppRunningError,
  DeploymentFinishedError,
  DeploymentNotFoundError,
  ValidationError,
} from "../src/state/errors.js";

const BASE = "2026-01-01T00:00:00.000Z";

function newStore(): { store: Store; clock: FakeClock } {
  const clock = new FakeClock(new Date(BASE));
  let n = 0;
  const store = openStore(":memory:", {
    clock,
    newId: () => `d${++n}`,
  });
  return { store, clock };
}

test("the status constants name every state and the three final ones", () => {
  assert.deepEqual(DEPLOYMENT_STATUSES, [
    "pending",
    "pulling",
    "starting",
    "running",
    "failed",
    "stopped",
    "replaced",
  ]);
  assert.deepEqual(FINAL_STATUSES, ["failed", "stopped", "replaced"]);
});

test("createDeployment records a pending deployment and getDeployment returns it", () => {
  const { store } = newStore();
  try {
    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    const deployment = createDeployment(store, { app: "web", image: "nginx:2" });
    assert.deepEqual(deployment, {
      id: "d1",
      app: "web",
      image: "nginx:2",
      status: "pending",
      containerId: null,
      error: null,
      createdAt: BASE,
      finishedAt: null,
    });
    assert.deepEqual(getDeployment(store, "d1"), deployment);
    assert.deepEqual(
      deploymentStatusChanges(store, "d1"),
      [{ status: "pending", at: BASE }],
    );
  } finally {
    store.close();
  }
});

test("createDeployment rejects an unknown app and an invalid image", () => {
  const { store } = newStore();
  try {
    assert.throws(
      () => createDeployment(store, { app: "nope", image: "nginx:1" }),
      AppNotFoundError,
    );

    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    assert.throws(
      () => createDeployment(store, { app: "web", image: "bad image" }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.field, "image");
        return true;
      },
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM deployments").get()?.n,
      0,
    );
  } finally {
    store.close();
  }
});

test("status changes are recorded oldest first with the clock's times", async () => {
  const { store, clock } = newStore();
  try {
    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    createDeployment(store, { app: "web", image: "nginx:1" });
    for (const status of ["pulling", "starting", "running"] as const) {
      await clock.advance(1000);
      setDeploymentStatus(store, "d1", status);
    }

    assert.deepEqual(
      deploymentStatusChanges(store, "d1").map((change) => change.status),
      ["pending", "pulling", "starting", "running"],
    );
    assert.deepEqual(
      deploymentStatusChanges(store, "d1").map((change) => change.at),
      [
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:03.000Z",
      ],
    );
    assert.equal(getDeployment(store, "d1").finishedAt, null);
  } finally {
    store.close();
  }
});

test("container id and error are stored and finish statuses set finishedAt", async () => {
  const { store, clock } = newStore();
  try {
    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    createDeployment(store, { app: "web", image: "nginx:1" });

    await clock.advance(1000);
    let deployment = setDeploymentStatus(store, "d1", "starting", {
      containerId: "c1",
    });
    assert.equal(deployment.containerId, "c1");
    assert.equal(deployment.error, null);
    assert.equal(deployment.finishedAt, null);

    await clock.advance(1000);
    deployment = setDeploymentStatus(store, "d1", "running");
    assert.equal(deployment.status, "running");
    assert.equal(deployment.containerId, "c1", "keeps the container id");

    await clock.advance(1000);
    deployment = setDeploymentStatus(store, "d1", "failed", {
      error: "exited with code 3",
    });
    assert.equal(deployment.status, "failed");
    assert.equal(deployment.error, "exited with code 3");
    assert.equal(deployment.containerId, "c1");
    assert.equal(deployment.finishedAt, "2026-01-01T00:00:03.000Z");
    assert.deepEqual(getDeployment(store, "d1"), deployment);
  } finally {
    store.close();
  }
});

test("stopped and replaced also set finishedAt", async () => {
  for (const status of ["stopped", "replaced"] as const) {
    const { store, clock } = newStore();
    try {
      createApp(store, { name: "web", image: "nginx:1", port: 80 });
      createDeployment(store, { app: "web", image: "nginx:1" });
      await clock.advance(500);
      const deployment = setDeploymentStatus(store, "d1", status);
      assert.equal(deployment.finishedAt, "2026-01-01T00:00:00.500Z");
    } finally {
      store.close();
    }
  }
});

test("finished deployments refuse any further change and stay unchanged", () => {
  for (const final of FINAL_STATUSES) {
    const { store } = newStore();
    try {
      createApp(store, { name: "web", image: "nginx:1", port: 80 });
      createDeployment(store, { app: "web", image: "nginx:1" });
      const finished = setDeploymentStatus(store, "d1", final);
      const events = deploymentStatusChanges(store, "d1").length;

      assert.throws(
        () => setDeploymentStatus(store, "d1", "running"),
        (error: unknown) => {
          assert.ok(error instanceof DeploymentFinishedError);
          assert.equal(error.message, `deployment "d1" is already ${final}`);
          return true;
        },
      );
      assert.deepEqual(getDeployment(store, "d1"), finished);
      assert.equal(deploymentStatusChanges(store, "d1").length, events);
    } finally {
      store.close();
    }
  }
});

test("an unknown deployment id is rejected by get, set and status changes", () => {
  const { store } = newStore();
  try {
    assert.throws(() => getDeployment(store, "nope"), DeploymentNotFoundError);
    assert.throws(
      () => setDeploymentStatus(store, "nope", "running"),
      DeploymentNotFoundError,
    );
    assert.throws(
      () => deploymentStatusChanges(store, "nope"),
      DeploymentNotFoundError,
    );
  } finally {
    store.close();
  }
});

test("latest and history follow creation order even when timestamps are equal", () => {
  const { store } = newStore();
  try {
    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    const first = createDeployment(store, { app: "web", image: "nginx:1" });
    const second = createDeployment(store, { app: "web", image: "nginx:2" });

    assert.deepEqual(latestDeployment(store, "web"), second);
    assert.deepEqual(
      deploymentHistory(store, "web").map((deployment) => deployment.id),
      [second.id, first.id],
    );
    assert.deepEqual(
      deploymentHistory(store, "web", { limit: 1 }).map((d) => d.id),
      [second.id],
    );
  } finally {
    store.close();
  }
});

test("an app with no deployments gives null and an empty history; unknown apps throw", () => {
  const { store } = newStore();
  try {
    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    assert.equal(latestDeployment(store, "web"), null);
    assert.deepEqual(deploymentHistory(store, "web"), []);

    assert.throws(() => latestDeployment(store, "nope"), AppNotFoundError);
    assert.throws(() => deploymentHistory(store, "nope"), AppNotFoundError);
  } finally {
    store.close();
  }
});

test("deleteApp respects running deployments and cascades to deployments and history", () => {
  const { store } = newStore();
  try {
    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    createDeployment(store, { app: "web", image: "nginx:1" });
    setDeploymentStatus(store, "d1", "running");

    assert.throws(() => deleteApp(store, "web"), AppRunningError);
    assert.equal(getApp(store, "web").name, "web");
    assert.equal(getDeployment(store, "d1").status, "running");

    setDeploymentStatus(store, "d1", "stopped");
    deleteApp(store, "web");

    assert.throws(() => getDeployment(store, "d1"), DeploymentNotFoundError);
    assert.throws(
      () => deploymentStatusChanges(store, "d1"),
      DeploymentNotFoundError,
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM deployment_events WHERE deployment_id = ?")
        .get("d1")?.n,
      0,
    );
  } finally {
    store.close();
  }
});
