import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FakeClock } from "../src/clock.js";
import { runReconcile } from "../src/commands/reconcile.js";
import { APP_LABEL } from "../src/deployments/types.js";
import type { IngressDeps } from "../src/ingress/caddy.js";
import { FakeCaddyAdmin } from "../src/ingress/fake-admin.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { openStore } from "../src/state/db.js";
import {
  createDeployment,
  deploymentHistory,
  deploymentStatusChanges,
  setDeploymentStatus,
} from "../src/state/deployments.js";
import { stateDbPath } from "../src/state/paths.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-reconcile-redeploy-cli-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Capture {
  io: Io;
  out: string;
  err: string;
}

function capture(): Capture {
  const state = { out: "", err: "" };
  return {
    io: {
      out: (text) => {
        state.out += text;
      },
      err: (text) => {
        state.err += text;
      },
    },
    get out() {
      return state.out;
    },
    get err() {
      return state.err;
    },
  };
}

interface CommandResult {
  code: number;
  out: string;
  err: string;
}

interface Harness {
  dir: string;
  clock: FakeClock;
  runtime: FakeRuntime;
  admin: FakeCaddyAdmin;
  options: {
    env: NodeJS.ProcessEnv;
    runtime: () => FakeRuntime;
    clock: FakeClock;
    admin: () => FakeCaddyAdmin;
  };
}

function makeHarness(
  runtimeFactory: (clock: FakeClock) => FakeRuntime = (clock) =>
    new FakeRuntime({ clock }),
): Harness {
  const dir = tempDir();
  const clock = new FakeClock();
  const runtime = runtimeFactory(clock);
  const admin = new FakeCaddyAdmin();
  return {
    dir,
    clock,
    runtime,
    admin,
    options: {
      env: { PAAS_HOME: dir },
      runtime: () => runtime,
      clock,
      admin: () => admin,
    },
  };
}

async function invoke(
  harness: Harness,
  argv: readonly string[],
): Promise<CommandResult> {
  const captureState = capture();
  const program = buildProgram(captureState.io, harness.options);
  const code = await run(argv, captureState.io, program);
  return { code, out: captureState.out, err: captureState.err };
}

async function flush(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Start a command without awaiting, let the engine reach its health sleep,
 * advance the fake clock, then await the command.
 */
async function deployAndAdvance(
  harness: Harness,
  argv: readonly string[],
  advanceMs = 3_000,
): Promise<CommandResult> {
  const captureState = capture();
  const program = buildProgram(captureState.io, harness.options);
  const promise = run(argv, captureState.io, program);
  await flush();
  await harness.clock.advance(advanceMs);
  const code = await promise;
  return { code, out: captureState.out, err: captureState.err };
}

/**
 * Like {@link deployAndAdvance}, but keeps advancing while the command runs
 * so a redeploy buried behind the plan and apply steps still sees the window.
 */
async function runAdvancing(
  harness: Harness,
  argv: readonly string[],
  advanceMs = 3_000,
): Promise<CommandResult> {
  const captureState = capture();
  const program = buildProgram(captureState.io, harness.options);
  let settled = false;
  const promise = run(argv, captureState.io, program).then((code) => {
    settled = true;
    return code;
  });
  for (let i = 0; i < 50 && !settled; i += 1) {
    await flush();
    await harness.clock.advance(advanceMs);
  }
  const code = await promise;
  return { code, out: captureState.out, err: captureState.err };
}

function withStore<T>(
  harness: Harness,
  fn: (store: ReturnType<typeof openStore>) => T,
): T {
  const store = openStore(stateDbPath({ PAAS_HOME: harness.dir }), {
    clock: harness.clock,
  });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

async function withStoreAsync<T>(
  harness: Harness,
  fn: (deps: IngressDeps) => Promise<T>,
): Promise<T> {
  const store = openStore(stateDbPath({ PAAS_HOME: harness.dir }), {
    clock: harness.clock,
  });
  try {
    return await fn({
      store,
      runtime: harness.runtime,
      clock: harness.clock,
      admin: harness.admin,
    });
  } finally {
    store.close();
  }
}

/** Create app `web` with a hostname, without bringing ingress up. */
async function createWeb(harness: Harness): Promise<void> {
  const created = await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "8080",
    "--host",
    "web.localhost",
  ]);
  assert.equal(created.code, 0, created.err);
}

/** Add a leftover managed container labelled with `app`, and return its id. */
async function addOrphan(
  harness: Harness,
  name: string,
  app: string,
): Promise<string> {
  await harness.runtime.pullImage("nginx:1");
  return harness.runtime.createContainer({
    name,
    image: "nginx:1",
    labels: { [APP_LABEL]: app },
  });
}

function onlyDeployment(harness: Harness, app: string) {
  const history = withStore(harness, (store) => deploymentHistory(store, app));
  assert.ok(history.length > 0, `expected a deployment for ${app}`);
  return history[0]!;
}

test("an app failed by an earlier reconcile is redeployed", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);
  const previous = onlyDeployment(harness, "web");
  await harness.runtime.removeContainer(previous.containerId!, { force: true });

  const failed = await invoke(harness, ["reconcile"]);

  assert.equal(failed.code, 0, failed.err);
  assert.equal(
    failed.out,
    `fail: web deployment ${previous.id} (container disappeared)\n`,
  );
  assert.equal(onlyDeployment(harness, "web").status, "failed");

  const result = await runAdvancing(harness, ["reconcile", "--redeploy"]);

  assert.equal(result.code, 0, result.err);
  const newest = onlyDeployment(harness, "web");
  assert.notEqual(newest.id, previous.id);
  assert.equal(newest.status, "running");
  assert.equal(
    result.out,
    `redeploy: web (deployment ${newest.id} is running)\n`,
  );
});

test("--dry-run --redeploy plans the redeploy and changes nothing", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);
  const running = onlyDeployment(harness, "web");
  await harness.runtime.removeContainer(running.containerId!, { force: true });

  const result = await invoke(harness, [
    "reconcile",
    "--dry-run",
    "--redeploy",
  ]);

  assert.equal(result.code, 0, result.err);
  assert.equal(
    result.out,
    "dry run: nothing was changed\n" +
      `fail: web deployment ${running.id} (container disappeared)\n` +
      "redeploy: web (planned)\n",
  );
  const after = onlyDeployment(harness, "web");
  assert.equal(after.id, running.id);
  assert.equal(after.status, "running");
});

test("a health-failed deployment is not redeployed", async () => {
  const harness = makeHarness(
    (clock) =>
      new FakeRuntime({ clock, scripts: { "bad:1": { exitCode: 3 } } }),
  );
  const created = await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "bad:1",
    "--port",
    "8080",
  ]);
  assert.equal(created.code, 0, created.err);

  const deployed = await invoke(harness, ["deploy", "web"]);
  assert.equal(deployed.code, 1, deployed.err);
  const latest = onlyDeployment(harness, "web");
  assert.equal(latest.status, "failed");
  const changes = withStore(harness, (store) =>
    deploymentStatusChanges(store, latest.id),
  );
  assert.ok(!changes.some((change) => change.status === "running"));

  const result = await invoke(harness, ["reconcile", "--redeploy"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "nothing to reconcile\n");
});

test("a stopped app is not redeployed", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);
  const stopped = await invoke(harness, ["stop", "web"]);
  assert.equal(stopped.code, 0, stopped.err);

  const result = await invoke(harness, ["reconcile", "--redeploy"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "nothing to reconcile\n");
});

test("a stuck deployment is never redeployed", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  const stuck = withStore(harness, (store) => {
    const deployment = createDeployment(store, {
      app: "web",
      image: "nginx:1",
    });
    setDeploymentStatus(store, deployment.id, "pulling");
    const changes = deploymentStatusChanges(store, deployment.id);
    return { id: deployment.id, at: changes[changes.length - 1]!.at };
  });
  await harness.clock.advance(600_001);

  const result = await invoke(harness, ["reconcile", "--redeploy"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(
    result.out,
    `fail: web deployment ${stuck.id} (stuck in pulling since ${stuck.at})\n`,
  );
  assert.ok(!result.out.includes("redeploy:"));
});

test("earlier failures are redeployed in app name order", async () => {
  const harness = makeHarness();
  for (const app of ["web", "api"]) {
    const created = await invoke(harness, [
      "apps",
      "create",
      app,
      "--image",
      "nginx:1",
      "--port",
      "8080",
    ]);
    assert.equal(created.code, 0, created.err);
  }
  await deployAndAdvance(harness, ["deploy", "web"]);
  await deployAndAdvance(harness, ["deploy", "api"]);
  for (const app of ["web", "api"]) {
    const deployment = onlyDeployment(harness, app);
    await harness.runtime.removeContainer(deployment.containerId!, {
      force: true,
    });
  }
  const failed = await invoke(harness, ["reconcile"]);
  assert.equal(failed.code, 0, failed.err);

  const result = await runAdvancing(harness, ["reconcile", "--redeploy"]);

  assert.equal(result.code, 0, result.err);
  const lines = result.out.trimEnd().split("\n");
  assert.equal(lines.length, 2, result.out);
  assert.match(lines[0]!, /^redeploy: api \(deployment .+ is running\)$/);
  assert.match(lines[1]!, /^redeploy: web \(deployment .+ is running\)$/);
  assert.equal(onlyDeployment(harness, "api").status, "running");
  assert.equal(onlyDeployment(harness, "web").status, "running");
});

test("orphan and prune lines name the container and items carry name", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  await addOrphan(harness, "web-old", "web");

  const report = await withStoreAsync(harness, (deps) =>
    runReconcile(deps, { dryRun: true, prune: false, redeploy: false }),
  );
  const orphan = report.items.find((item) => item.kind === "orphan");
  assert.ok(orphan !== undefined, JSON.stringify(report.items));
  assert.equal(orphan.name, "web-old");

  const human = await invoke(harness, ["reconcile"]);

  assert.equal(human.code, 0, human.err);
  assert.equal(human.out, "orphan: web-old (app web; use --prune to remove)\n");

  const pruned = await invoke(harness, ["reconcile", "--prune"]);

  assert.equal(pruned.code, 0, pruned.err);
  assert.equal(pruned.out, "prune: web-old (removed)\n");
});

test("--json items keep exactly the six documented keys", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  await addOrphan(harness, "web-old", "web");

  const result = await invoke(harness, ["reconcile", "--json"]);

  assert.equal(result.code, 0, result.err);
  const parsed = JSON.parse(result.out.trimEnd()) as {
    dryRun: boolean;
    items: Array<Record<string, unknown>>;
  };
  const orphan = parsed.items.find((item) => item.kind === "orphan");
  assert.ok(orphan !== undefined, result.out);
  assert.equal(orphan.name, undefined);
  assert.deepEqual(Object.keys(orphan).sort(), [
    "app",
    "containerId",
    "deploymentId",
    "detail",
    "kind",
    "ok",
  ]);
});

test("reconcile.ts contains no WeakMap", () => {
  const source = readFileSync(
    new URL("../src/commands/reconcile.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!source.includes("WeakMap"));
});
