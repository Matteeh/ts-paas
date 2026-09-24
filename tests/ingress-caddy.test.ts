import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../src/clock.js";
import { PAAS_NETWORK } from "../src/deployments/types.js";
import {
  type CaddyAdmin,
  AdminRequestError,
  AdminUnreachableError,
} from "../src/ingress/admin.js";
import {
  CADDY_IMAGE,
  type IngressDeps,
  ingressDown,
  ingressStatus,
  ingressUp,
  syncIngress,
} from "../src/ingress/caddy.js";
import {
  buildCaddyConfig,
  desiredRoutes,
  routesFromConfig,
} from "../src/ingress/config.js";
import { FakeCaddyAdmin } from "../src/ingress/fake-admin.js";
import { ContainerNotFoundError } from "../src/runtime/errors.js";
import { FakeRuntime, type FakeRuntimeOptions } from "../src/runtime/fake.js";
import type { ContainerSpec } from "../src/runtime/types.js";
import { createApp } from "../src/state/apps.js";
import { openStore, type Store } from "../src/state/db.js";
import { ValidationError } from "../src/state/errors.js";
import {
  DEFAULT_INGRESS_SETTINGS,
  type IngressSettings,
  type TlsMode,
  setIngressSettings,
} from "../src/state/settings.js";
import {
  createDeployment,
  setDeploymentStatus,
} from "../src/state/deployments.js";

const BASE = "2026-01-01T00:00:00.000Z";

class RecordingRuntime extends FakeRuntime {
  readonly pulls: string[] = [];
  readonly specs: ContainerSpec[] = [];
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly removed: string[] = [];
  readonly ensuredNetworks: string[] = [];
  readonly ensuredVolumes: string[] = [];

  override async pullImage(ref: string): Promise<void> {
    this.pulls.push(ref);
    await super.pullImage(ref);
  }

  override async createContainer(spec: ContainerSpec): Promise<string> {
    this.specs.push(spec);
    return super.createContainer(spec);
  }

  override async startContainer(idOrName: string): Promise<void> {
    this.started.push(idOrName);
    await super.startContainer(idOrName);
  }

  override async stopContainer(
    idOrName: string,
    options?: { timeoutSeconds?: number },
  ): Promise<void> {
    this.stopped.push(idOrName);
    await super.stopContainer(idOrName, options);
  }

  override async removeContainer(
    idOrName: string,
    options?: { force?: boolean },
  ): Promise<void> {
    this.removed.push(idOrName);
    await super.removeContainer(idOrName, options);
  }

  override async ensureNetwork(name: string): Promise<void> {
    this.ensuredNetworks.push(name);
    await super.ensureNetwork(name);
  }

  override async ensureVolume(name: string): Promise<void> {
    this.ensuredVolumes.push(name);
    await super.ensureVolume(name);
  }
}

interface Harness {
  store: Store;
  runtime: RecordingRuntime;
  clock: FakeClock;
  admin: FakeCaddyAdmin;
  deps: IngressDeps;
}

function harness(admin: CaddyAdmin = new FakeCaddyAdmin()): Harness {
  const clock = new FakeClock(new Date(BASE));
  let n = 0;
  const store = openStore(":memory:", { clock, newId: () => `d${++n}` });
  const runtime = new RecordingRuntime({ clock } satisfies FakeRuntimeOptions);
  const deps: IngressDeps = { store, runtime, clock, admin };
  return { store, runtime, clock, admin: admin as FakeCaddyAdmin, deps };
}

function seedApp(store: Store): void {
  createApp(store, {
    name: "web",
    image: "nginx:1",
    port: 8080,
    hostname: "web.localhost",
  });
  createDeployment(store, { app: "web", image: "nginx:1" });
  setDeploymentStatus(store, "d1", "running", { containerId: "c1" });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("first up creates everything and pushes the exact config", async () => {
  const { store, runtime, admin, deps } = harness();
  try {
    seedApp(store);

    const result = await ingressUp(deps);

    assert.equal(result.action, "created");
    assert.deepEqual(result.settings, DEFAULT_INGRESS_SETTINGS);
    assert.deepEqual(result.routes, [
      { hostname: "web.localhost", upstream: "web-d1:8080" },
    ]);

    assert.deepEqual(runtime.pulls, [CADDY_IMAGE]);
    assert.deepEqual(runtime.ensuredNetworks, [PAAS_NETWORK]);
    assert.deepEqual(runtime.ensuredVolumes, ["paas-caddy-data"]);
    assert.equal(runtime.specs.length, 1);
    assert.deepEqual(runtime.specs[0], {
      name: "paas-caddy",
      image: CADDY_IMAGE,
      env: { CADDY_ADMIN: "0.0.0.0:2019" },
      labels: {
        "paas.ingress": "caddy",
        "paas.ingress.http-port": "80",
        "paas.ingress.https-port": "443",
      },
      network: "paas-net",
      restartPolicy: "unless-stopped",
      publish: [
        { hostIp: "", hostPort: 80, containerPort: 80 },
        { hostIp: "", hostPort: 443, containerPort: 443 },
        { hostIp: "127.0.0.1", hostPort: 2019, containerPort: 2019 },
      ],
      volumes: [{ volume: "paas-caddy-data", path: "/data" }],
    });

    assert.equal(await runtime.networkExists(PAAS_NETWORK), true);
    assert.equal(
      (await runtime.inspectContainer("paas-caddy")).state,
      "running",
    );

    assert.equal(admin.loads.length, 1);
    assert.deepEqual(
      admin.loads[0],
      buildCaddyConfig("off", desiredRoutes(store)),
    );
  } finally {
    store.close();
  }
});

test("port 2019 is published only on loopback and honors a custom admin port", async () => {
  const { store, runtime, deps } = harness();
  try {
    await ingressUp({
      ...deps,
      target: {
        container: "paas-caddy",
        volume: "paas-caddy-data",
        adminPort: 12019,
      },
    });

    const publish = runtime.specs[0]!.publish!;
    assert.deepEqual(
      publish.find((entry) => entry.containerPort === 2019),
      { hostIp: "127.0.0.1", hostPort: 12019, containerPort: 2019 },
    );
    assert.equal(
      publish.filter((entry) => entry.containerPort === 2019).length,
      1,
    );
    assert.deepEqual(
      publish.find((entry) => entry.containerPort === 80),
      { hostIp: "", hostPort: 80, containerPort: 80 },
    );
    assert.deepEqual(
      publish.find((entry) => entry.containerPort === 443),
      { hostIp: "", hostPort: 443, containerPort: 443 },
    );
  } finally {
    store.close();
  }
});

test("up is idempotent, starts a stopped container, and recreates on a port change", async () => {
  const { store, runtime, deps } = harness();
  try {
    assert.equal((await ingressUp(deps)).action, "created");
    const firstId = (await runtime.inspectContainer("paas-caddy")).id;

    const second = await ingressUp(deps);
    assert.equal(second.action, "unchanged");
    assert.deepEqual(runtime.pulls, [CADDY_IMAGE]);
    assert.equal((await runtime.inspectContainer("paas-caddy")).id, firstId);

    await runtime.stopContainer("paas-caddy");
    const third = await ingressUp(deps);
    assert.equal(third.action, "started");
    assert.equal((await runtime.inspectContainer("paas-caddy")).id, firstId);

    const fourth = await ingressUp(deps, { httpPort: 8080 });
    assert.equal(fourth.action, "recreated");
    const fourthInfo = await runtime.inspectContainer("paas-caddy");
    assert.notEqual(fourthInfo.id, firstId);
    assert.deepEqual(
      runtime.specs[runtime.specs.length - 1]!.publish!.find(
        (entry) => entry.containerPort === 80,
      ),
      { hostIp: "", hostPort: 8080, containerPort: 80 },
    );
    assert.equal(fourth.settings.httpPort, 8080);
  } finally {
    store.close();
  }
});

test("an invalid setting rejects before any runtime call", async () => {
  const { store, runtime, admin, deps } = harness();
  try {
    await assert.rejects(
      ingressUp(deps, { tls: "on" as TlsMode }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.field, "tls");
        return true;
      },
    );

    assert.deepEqual(runtime.pulls, []);
    assert.deepEqual(runtime.specs, []);
    assert.deepEqual(runtime.ensuredNetworks, []);
    assert.deepEqual(runtime.ensuredVolumes, []);
    assert.equal(admin.loads.length, 0);
    await assert.rejects(
      runtime.inspectContainer("paas-caddy"),
      (error: unknown) => error instanceof ContainerNotFoundError,
    );
  } finally {
    store.close();
  }
});

test("up retries an unreachable admin API every 250 ms and then succeeds", async () => {
  const { store, clock, admin, deps } = harness();
  try {
    admin.failures = [
      new AdminUnreachableError("cannot reach Caddy admin API: refused"),
      new AdminUnreachableError("cannot reach Caddy admin API: refused"),
    ];

    const promise = ingressUp(deps);
    await flush();
    await clock.advance(250);
    await clock.advance(250);

    assert.equal((await promise).action, "created");
    assert.equal(admin.loads.length, 1);
  } finally {
    store.close();
  }
});

test("an admin API error status rejects at once", async () => {
  const { store, admin, deps } = harness();
  try {
    admin.failures = [
      new AdminRequestError(400, "Caddy admin API answered 400: bad config"),
    ];

    await assert.rejects(
      ingressUp(deps),
      (error: unknown) => error instanceof AdminRequestError,
    );
    assert.equal(admin.loads.length, 0);
  } finally {
    store.close();
  }
});

test("down stops and removes the container, keeps the volume, and reports nothing twice", async () => {
  const { store, runtime, deps } = harness();
  try {
    await ingressUp(deps);
    const volumeCalls = runtime.ensuredVolumes.length;

    assert.equal(await ingressDown(deps), true);
    assert.deepEqual(runtime.stopped, ["paas-caddy"]);
    assert.deepEqual(runtime.removed, ["paas-caddy"]);
    await assert.rejects(
      runtime.inspectContainer("paas-caddy"),
      (error: unknown) => error instanceof ContainerNotFoundError,
    );

    assert.equal(await ingressDown(deps), false);
    assert.equal(runtime.stopped.length, 1);
    assert.equal(runtime.removed.length, 1);
    assert.equal(runtime.ensuredVolumes.length, volumeCalls);
  } finally {
    store.close();
  }
});

test("syncIngress pushes once only while the container runs", async () => {
  const { store, runtime, admin, deps } = harness();
  try {
    assert.equal(await syncIngress(deps), false);
    assert.equal(admin.loads.length, 0);

    await ingressUp(deps);
    const afterUp = admin.loads.length;

    assert.equal(await syncIngress(deps), true);
    assert.equal(admin.loads.length, afterUp + 1);

    await runtime.stopContainer("paas-caddy");
    assert.equal(await syncIngress(deps), false);
    assert.equal(admin.loads.length, afterUp + 1);
  } finally {
    store.close();
  }
});

test("syncIngress rejects with the admin error when the push fails", async () => {
  const { store, admin, deps } = harness();
  try {
    await ingressUp(deps);
    admin.failures = [
      new AdminRequestError(500, "Caddy admin API answered 500: boom"),
    ];

    await assert.rejects(
      syncIngress(deps),
      (error: unknown) => error instanceof AdminRequestError,
    );
  } finally {
    store.close();
  }
});

test("ingressStatus reports missing, stopped and running with Caddy's routes", async () => {
  const { store, runtime, admin, deps } = harness();
  try {
    seedApp(store);

    const missing = await ingressStatus(deps);
    assert.equal(missing.caddy, "missing");
    assert.equal(missing.routes, null);
    assert.deepEqual(missing.settings, DEFAULT_INGRESS_SETTINGS);

    setIngressSettings(store, { tls: "auto" });
    assert.deepEqual((await ingressStatus(deps)).settings, {
      tls: "auto",
      httpPort: 80,
      httpsPort: 443,
    } satisfies IngressSettings);

    await ingressUp(deps);
    const running = await ingressStatus(deps);
    assert.equal(running.caddy, "running");
    assert.deepEqual(running.routes, [
      { hostname: "web.localhost", upstream: "web-d1:8080" },
    ]);
    assert.deepEqual(running.routes, routesFromConfig(await admin.getConfig()));

    await runtime.stopContainer("paas-caddy");
    const stopped = await ingressStatus(deps);
    assert.equal(stopped.caddy, "stopped");
    assert.equal(stopped.routes, null);
  } finally {
    store.close();
  }
});
