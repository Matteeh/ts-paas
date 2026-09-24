import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../src/clock.js";
import { FakeCaddyAdmin } from "../src/ingress/fake-admin.js";
import { type IngressDeps, ingressUp } from "../src/ingress/caddy.js";
import { ContainerNotFoundError, PortInUseError } from "../src/runtime/errors.js";
import { FakeRuntime, type FakeRuntimeOptions } from "../src/runtime/fake.js";
import { openStore, type Store } from "../src/state/db.js";

const BASE = "2026-01-01T00:00:00.000Z";

/**
 * A FakeRuntime that can be told to fail the next start and, separately, the
 * cleanup removal. The start error is created once so tests can assert the
 * exact object identity.
 */
class FailingRuntime extends FakeRuntime {
  failStart = false;
  failRemove = false;
  readonly startError = new PortInUseError(
    "rootlessport listen tcp 127.0.0.1:2019: bind: address already in use",
    "127.0.0.1:2019",
  );
  readonly removalError = new Error("force remove failed");

  override async startContainer(idOrName: string): Promise<void> {
    if (this.failStart) {
      throw this.startError;
    }
    await super.startContainer(idOrName);
  }

  override async removeContainer(
    idOrName: string,
    options?: { force?: boolean },
  ): Promise<void> {
    if (this.failRemove) {
      throw this.removalError;
    }
    await super.removeContainer(idOrName, options);
  }
}

interface Harness {
  store: Store;
  runtime: FailingRuntime;
  clock: FakeClock;
  admin: FakeCaddyAdmin;
  deps: IngressDeps;
}

function harness(): Harness {
  const clock = new FakeClock(new Date(BASE));
  const store = openStore(":memory:", { clock, newId: () => "d1" });
  const runtime = new FailingRuntime({ clock } satisfies FakeRuntimeOptions);
  const admin = new FakeCaddyAdmin();
  const deps: IngressDeps = { store, runtime, clock, admin };
  return { store, runtime, clock, admin, deps };
}

async function assertMissing(
  runtime: FailingRuntime,
  name: string,
): Promise<void> {
  await assert.rejects(
    runtime.inspectContainer(name),
    (error: unknown) => error instanceof ContainerNotFoundError,
  );
}

test("a failed first up removes the new paas-caddy and rejects with the start error", async () => {
  const { store, runtime, admin, deps } = harness();
  try {
    runtime.failStart = true;

    await assert.rejects(ingressUp(deps), (error: unknown) => {
      assert.equal(error, runtime.startError);
      return true;
    });

    await assertMissing(runtime, "paas-caddy");
    assert.equal(admin.loads.length, 0);
  } finally {
    store.close();
  }
});

test("a failed cleanup leaves the start error as the rejection", async () => {
  const { store, runtime, admin, deps } = harness();
  try {
    runtime.failStart = true;
    runtime.failRemove = true;

    await assert.rejects(ingressUp(deps), (error: unknown) => {
      assert.equal(error, runtime.startError);
      assert.notEqual(error, runtime.removalError);
      return true;
    });

    assert.equal(admin.loads.length, 0);
  } finally {
    store.close();
  }
});

test("a second up after a failed first up creates and runs paas-caddy", async () => {
  const { store, runtime, deps } = harness();
  try {
    runtime.failStart = true;
    await assert.rejects(ingressUp(deps), (error: unknown) =>
      error === runtime.startError,
    );

    runtime.failStart = false;
    const result = await ingressUp(deps);

    assert.equal(result.action, "created");
    assert.equal((await runtime.inspectContainer("paas-caddy")).state, "running");
  } finally {
    store.close();
  }
});

test("an existing exited paas-caddy that fails to start is left in place", async () => {
  const { store, runtime, admin, deps } = harness();
  try {
    await ingressUp(deps);
    await runtime.stopContainer("paas-caddy");
    assert.equal(admin.loads.length, 1);

    runtime.failStart = true;
    await assert.rejects(ingressUp(deps), (error: unknown) =>
      error === runtime.startError,
    );

    const info = await runtime.inspectContainer("paas-caddy");
    assert.equal(info.state, "exited");
    assert.equal(admin.loads.length, 1);
  } finally {
    store.close();
  }
});

test("a failed recreate on a port change leaves no paas-caddy", async () => {
  const { store, runtime, deps } = harness();
  try {
    await ingressUp(deps);

    runtime.failStart = true;
    await assert.rejects(
      ingressUp(deps, { httpPort: 8080 }),
      (error: unknown) => error === runtime.startError,
    );

    await assertMissing(runtime, "paas-caddy");
  } finally {
    store.close();
  }
});
