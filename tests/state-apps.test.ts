import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../src/clock.js";
import {
  createApp,
  deleteApp,
  getApp,
  listApps,
  updateApp,
} from "../src/state/apps.js";
import { openStore, type Store } from "../src/state/db.js";
import {
  AppExistsError,
  AppNotFoundError,
  AppRunningError,
  HostnameInUseError,
  ValidationError,
} from "../src/state/errors.js";

const BASE = "2026-01-01T00:00:00.000Z";

function newStore(): { store: Store; clock: FakeClock } {
  const clock = new FakeClock(new Date(BASE));
  const store = openStore(":memory:", { clock });
  return { store, clock };
}

function expectValidation(field: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ValidationError, `${field}: expected ValidationError`);
    assert.equal(error.field, field);
    return true;
  });
}

function seedDeployment(
  store: Store,
  id: string,
  app: string,
  status: string,
): void {
  store.db
    .prepare(
      "INSERT INTO deployments (id, app, image, status, container_id, error, created_at, finished_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)",
    )
    .run(id, app, "nginx:1", status, BASE);
}

test("createApp stores defaults and getApp returns an equal object", () => {
  const { store } = newStore();
  try {
    const web = createApp(store, { name: "web", image: "nginx:1", port: 80 });
    assert.deepEqual(web, {
      name: "web",
      image: "nginx:1",
      port: 80,
      hostname: null,
      env: {},
      createdAt: BASE,
      updatedAt: BASE,
    });
    assert.deepEqual(getApp(store, "web"), web);
  } finally {
    store.close();
  }
});

test("createApp lowercases the hostname", () => {
  const { store } = newStore();
  try {
    const app = createApp(store, {
      name: "web",
      image: "nginx:1",
      port: 80,
      hostname: "Whoami.Localhost",
    });
    assert.equal(app.hostname, "whoami.localhost");
    assert.equal(getApp(store, "web").hostname, "whoami.localhost");
  } finally {
    store.close();
  }
});

test("listApps orders by name", () => {
  const { store } = newStore();
  try {
    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    createApp(store, { name: "api", image: "node:24", port: 3000 });
    createApp(store, { name: "blog", image: "ghost:5", port: 2368 });
    assert.deepEqual(
      listApps(store).map((app) => app.name),
      ["api", "blog", "web"],
    );
  } finally {
    store.close();
  }
});

test("createApp rejects invalid input and stores nothing", () => {
  const { store } = newStore();
  try {
    expectValidation("name", () =>
      createApp(store, { name: "Web", image: "nginx:1", port: 80 }),
    );
    expectValidation("image", () =>
      createApp(store, { name: "web", image: "", port: 80 }),
    );
    expectValidation("port", () =>
      createApp(store, { name: "web", image: "nginx:1", port: 0 }),
    );
    expectValidation("hostname", () =>
      createApp(store, {
        name: "web",
        image: "nginx:1",
        port: 80,
        hostname: "a_b.com",
      }),
    );
    expectValidation("env", () =>
      createApp(store, {
        name: "web",
        image: "nginx:1",
        port: 80,
        env: { "1A": "x" },
      }),
    );
    assert.deepEqual(listApps(store), []);
  } finally {
    store.close();
  }
});

test("creating a duplicate name fails with AppExistsError", () => {
  const { store } = newStore();
  try {
    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    assert.throws(
      () => createApp(store, { name: "web", image: "httpd:2", port: 8080 }),
      AppExistsError,
    );
  } finally {
    store.close();
  }
});

test("hostnames are unique across create and update", () => {
  const { store } = newStore();
  try {
    createApp(store, {
      name: "a",
      image: "nginx:1",
      port: 80,
      hostname: "x.localhost",
    });
    createApp(store, { name: "b", image: "nginx:1", port: 81 });

    assert.throws(
      () =>
        createApp(store, {
          name: "c",
          image: "nginx:1",
          port: 82,
          hostname: "x.localhost",
        }),
      HostnameInUseError,
    );
    assert.throws(
      () => updateApp(store, "b", { hostname: "x.localhost" }),
      HostnameInUseError,
    );

    const kept = updateApp(store, "a", { hostname: "x.localhost" });
    assert.equal(kept.hostname, "x.localhost");
  } finally {
    store.close();
  }
});

test("getApp, updateApp and deleteApp reject an unknown name", () => {
  const { store } = newStore();
  try {
    assert.throws(() => getApp(store, "nope"), AppNotFoundError);
    assert.throws(() => updateApp(store, "nope", { port: 1 }), AppNotFoundError);
    assert.throws(() => deleteApp(store, "nope"), AppNotFoundError);
  } finally {
    store.close();
  }
});

test("updateApp changes only named fields and moves updatedAt", async () => {
  const { store, clock } = newStore();
  try {
    const created = createApp(store, {
      name: "web",
      image: "nginx:1",
      port: 80,
      hostname: "web.localhost",
      env: { A: "1", B: "2" },
    });
    await clock.advance(60_000);

    const updated = updateApp(store, "web", { port: 8080 });
    assert.equal(updated.port, 8080);
    assert.equal(updated.image, "nginx:1");
    assert.equal(updated.hostname, "web.localhost");
    assert.deepEqual(updated.env, { A: "1", B: "2" });
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, "2026-01-01T00:01:00.000Z");
    assert.deepEqual(getApp(store, "web"), updated);
  } finally {
    store.close();
  }
});

test("updateApp replaces the whole environment", () => {
  const { store } = newStore();
  try {
    createApp(store, {
      name: "web",
      image: "nginx:1",
      port: 80,
      env: { A: "1", B: "2" },
    });
    const updated = updateApp(store, "web", { env: { A: "3" } });
    assert.deepEqual(updated.env, { A: "3" });
    assert.deepEqual(getApp(store, "web").env, { A: "3" });
  } finally {
    store.close();
  }
});

test("updateApp clears the hostname when given null", () => {
  const { store } = newStore();
  try {
    createApp(store, {
      name: "web",
      image: "nginx:1",
      port: 80,
      hostname: "web.localhost",
    });
    const updated = updateApp(store, "web", { hostname: null });
    assert.equal(updated.hostname, null);
    assert.equal(getApp(store, "web").hostname, null);
  } finally {
    store.close();
  }
});

test("updateApp rejects invalid changes and changes nothing", () => {
  const { store } = newStore();
  try {
    createApp(store, {
      name: "web",
      image: "nginx:1",
      port: 80,
      hostname: "web.localhost",
      env: { A: "1" },
    });
    const before = getApp(store, "web");

    expectValidation("image", () => updateApp(store, "web", { image: "" }));
    expectValidation("port", () => updateApp(store, "web", { port: 70000 }));
    expectValidation("hostname", () =>
      updateApp(store, "web", { hostname: "a_b.com" }),
    );
    expectValidation("env", () => updateApp(store, "web", { env: { "A-B": "x" } }));

    assert.deepEqual(getApp(store, "web"), before);
  } finally {
    store.close();
  }
});

test("deleteApp refuses while a deployment is running and removes nothing", () => {
  const { store } = newStore();
  try {
    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    seedDeployment(store, "d1", "web", "running");

    assert.throws(
      () => deleteApp(store, "web"),
      (error: unknown) => {
        assert.ok(error instanceof AppRunningError);
        assert.match(error.message, /stop the app first/);
        return true;
      },
    );

    assert.equal(getApp(store, "web").name, "web");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE app = ?").get("web")?.n,
      1,
    );
  } finally {
    store.close();
  }
});

test("deleteApp removes the app, its deployments and history", () => {
  const { store } = newStore();
  try {
    createApp(store, { name: "web", image: "nginx:1", port: 80 });
    seedDeployment(store, "d1", "web", "failed");
    store.db
      .prepare(
        "INSERT INTO deployment_events (deployment_id, status, at) VALUES (?, ?, ?)",
      )
      .run("d1", "failed", BASE);

    deleteApp(store, "web");

    assert.throws(() => getApp(store, "web"), AppNotFoundError);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE app = ?").get("web")?.n,
      0,
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
